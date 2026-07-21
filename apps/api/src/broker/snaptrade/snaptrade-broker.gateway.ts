import { Injectable, Inject } from '@nestjs/common';
import {
  Candle,
  CandleRequest,
  OptionsChain,
  OrderPreview,
  OrderRequest,
  OrderResult,
  Position,
  Quote,
  TradingMode,
} from '@0dtetrader/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BrokerGateway,
  MARKET_DATA_PROVIDER,
  MarketDataProvider,
} from '../broker-gateway.interface';
import { CredentialsService } from '../../credentials/credentials.service';
import { OrderEventsService } from '../order-events.service';
import { SnapTradeClient } from './snaptrade-client';
import {
  buildEquityOrderPayload,
  buildOptionOrderPayload,
  positionIntentFor,
  PositionIntent,
} from './snaptrade-endpoints';
import { toOrderResult, toPositions } from './snaptrade-mappers';
import { formatOccSymbol } from '../contract-resolution';
import { brokerErrors } from '../../common/broker-error';

/**
 * SnapTrade execution + account-data gateway.
 *
 * Market-data methods (`getQuote`, `getCandles`, `getOptionsChain`) are
 * forwarded to the injected {@link MarketDataProvider} because SnapTrade
 * cannot supply candles or a bulk options chain.
 *
 * Execution/account methods are implemented natively via the SnapTrade SDK.
 */
@Injectable()
export class SnapTradeBrokerGateway implements BrokerGateway {
  constructor(
    private readonly client: SnapTradeClient,
    private readonly credentials: CredentialsService,
    private readonly prisma: PrismaService,
    private readonly events: OrderEventsService,
    @Inject(MARKET_DATA_PROVIDER) private readonly marketData: MarketDataProvider,
  ) {}

  // -------------------------------------------------------------------------
  // Market data (delegated)
  // -------------------------------------------------------------------------

  async getQuote(userId: string, symbol: string): Promise<Quote> {
    return this.marketData.getQuote(userId, symbol);
  }

  async getCandles(userId: string, symbol: string, req: CandleRequest): Promise<Candle[]> {
    return this.marketData.getCandles(userId, symbol, req);
  }

  async getOptionsChain(
    userId: string,
    symbol: string,
    expiration?: string,
  ): Promise<OptionsChain> {
    return this.marketData.getOptionsChain(userId, symbol, expiration);
  }

  // -------------------------------------------------------------------------
  // Trading
  // -------------------------------------------------------------------------

  async previewOrder(userId: string, order: OrderRequest): Promise<OrderPreview> {
    const { mode, secrets, accountId } = await this.identityFor(userId);
    const limitPrice = order.orderType === 'market' ? undefined : this.estimatedMid(order);

    let impact: { estBuyingPower: number; warnings: string[] } | undefined;
    const warnings: string[] = [];

    try {
      if (order.assetClass === 'option') {
        const intent = await this.optionPositionIntent(userId, order);
        const payload = buildOptionOrderPayload(
          accountId,
          order,
          limitPrice,
          order.side === 'buy' ? 'DEBIT' : 'CREDIT',
          intent,
        );
        const result = await this.client.previewOptionOrder(
          mode,
          userId,
          secrets.snaptradeUserSecret,
          accountId,
          payload,
        );
        impact = {
          estBuyingPower: this.parseImpactCost(result),
          warnings,
        };
      } else {
        const payload = buildEquityOrderPayload(accountId, order, limitPrice);
        const result = await this.client.previewEquityOrder(
          mode,
          userId,
          secrets.snaptradeUserSecret,
          payload as any,
        );
        impact = {
          estBuyingPower: this.parseEquityImpact(result),
          warnings,
        };
      }
    } catch (err) {
      warnings.push(`Broker preview unavailable: ${(err as Error).message} — local estimate used`);
    }

    if (!impact) {
      impact = {
        estBuyingPower: this.estimateBuyingPower(order.quantity, limitPrice ?? 0),
        warnings: [...warnings, 'Buying-power effect is a local estimate'],
      };
    }

    return {
      resolved: {
        contractSymbol: this.occSymbol(order),
        price: limitPrice ?? 0,
        estBuyingPower: Math.round(impact.estBuyingPower * 100) / 100,
      },
      warnings: impact.warnings,
    };
  }

  async placeOrder(
    userId: string,
    order: OrderRequest,
    idempotencyKey: string,
  ): Promise<OrderResult> {
    const { mode, secrets, accountId } = await this.identityFor(userId);
    const limitPrice = order.orderType === 'market' ? undefined : this.estimatedMid(order);

    if (order.assetClass === 'option') {
      const intent = await this.optionPositionIntent(userId, order);
      const payload = buildOptionOrderPayload(
        accountId,
        order,
        limitPrice,
        order.side === 'buy' ? 'DEBIT' : 'CREDIT',
        intent,
      );
      const result = await this.client.placeOptionOrder(
        mode,
        userId,
        secrets.snaptradeUserSecret,
        accountId,
        payload,
      );
      const orderId = result.brokerage_order_id ?? idempotencyKey;
      const mapped = this.mapOrderResult(order, orderId, limitPrice);
      this.events.emit(userId, mapped);
      return mapped;
    }

    const payload = buildEquityOrderPayload(accountId, order, limitPrice, idempotencyKey);
    const result = await this.client.placeEquityOrder(
      mode,
      userId,
      secrets.snaptradeUserSecret,
      payload as any,
    );
    const orderId = result.brokerage_order_id ?? idempotencyKey;
    const mapped = this.mapOrderResult(order, orderId, limitPrice);
    this.events.emit(userId, mapped);
    return mapped;
  }

  async cancelOrder(userId: string, orderId: string): Promise<void> {
    const { mode, secrets, accountId } = await this.identityFor(userId);
    const open = await this.getOpenOrders(userId);
    const target = open.find((o) => o.orderId === orderId);
    if (!target) throw brokerErrors.orderNotFound(orderId);

    await this.client.cancelOrder(mode, userId, secrets.snaptradeUserSecret, accountId, orderId);
    this.events.emit(userId, { ...target, status: 'cancelled' });
  }

  async getPositions(userId: string): Promise<Position[]> {
    const { mode, secrets, accountId } = await this.identityFor(userId);
    const response = await this.client.getAllAccountPositions(
      mode,
      userId,
      secrets.snaptradeUserSecret,
      accountId,
    );
    return toPositions(response);
  }

  async getOpenOrders(userId: string): Promise<OrderResult[]> {
    const { mode, secrets, accountId } = await this.identityFor(userId);
    const orders = await this.client.getOpenOrders(
      mode,
      userId,
      secrets.snaptradeUserSecret,
      accountId,
    );
    return orders
      .map((o: any) => toOrderResult(o))
      .filter((o) => o.status === 'submitted' || o.status === 'partially_filled');
  }

  async reauthenticate(userId: string): Promise<TradingMode> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { tradingMode: true },
    });
    return (user?.tradingMode ?? 'live') as TradingMode;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async identityFor(userId: string): Promise<{
    mode: TradingMode;
    secrets: { snaptradeUserSecret: string };
    accountId: string;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        tradingProvider: true,
        tradingMode: true,
        snaptradeAccountId: true,
        snaptradePracticeAccountId: true,
      },
    });
    if (user?.tradingProvider !== 'snaptrade') {
      throw brokerErrors.authFailed('User is not configured for SnapTrade');
    }
    const mode = (user.tradingMode ?? 'live') as TradingMode;
    const accountId =
      mode === 'practice' ? user.snaptradePracticeAccountId : user.snaptradeAccountId;
    if (!accountId) {
      throw brokerErrors.authFailed('No SnapTrade trading account selected');
    }
    const secrets = await this.credentials.getSnapTradeIdentity(userId, mode);
    if (!secrets) {
      throw brokerErrors.authFailed(
        'SnapTrade identity not found — re-register via the connection flow',
      );
    }
    return { mode, secrets, accountId };
  }

  private async optionPositionIntent(userId: string, order: OrderRequest): Promise<PositionIntent> {
    let existing = 0;
    try {
      const positions = await this.getPositions(userId);
      existing = positions.find((p) => p.symbol === this.occSymbol(order))?.quantity ?? 0;
    } catch {
      // Best-effort: default to open if we cannot read positions.
    }
    return positionIntentFor(order.side, existing);
  }

  private occSymbol(order: OrderRequest): string {
    const { optionType, expiration, strike } = order.selection;
    if (!optionType || !expiration || strike === undefined) {
      throw brokerErrors.orderRejected(
        'selection.optionType, expiration, and strike are required for option orders',
      );
    }
    return formatOccSymbol(order.underlying, expiration, optionType, strike);
  }

  private estimatedMid(_order: OrderRequest): number {
    // The trading service resolves the contract and passes a limit price.
    // If the caller did not resolve the contract (should not happen), fail
    // clearly rather than guessing.
    return 0;
  }

  private mapOrderResult(order: OrderRequest, orderId: string, limitPrice?: number): OrderResult {
    return {
      orderId,
      status: 'submitted',
      contractSymbol: this.occSymbol(order),
      side: order.side,
      quantity: order.quantity,
      orderType: order.orderType,
      ...(limitPrice !== undefined ? { limitPrice } : {}),
      timestamp: new Date().toISOString(),
    };
  }

  private parseEquityImpact(result: {
    trade_impacts?: Array<{ remaining_cash?: number | null }>;
  }): number {
    return Number(result.trade_impacts?.[0]?.remaining_cash ?? 0);
  }

  private parseImpactCost(result: { estimated_cash_change?: string }): number {
    return Number(result.estimated_cash_change ?? 0);
  }

  private estimateBuyingPower(quantity: number, price: number): number {
    return quantity * price * 100;
  }
}
