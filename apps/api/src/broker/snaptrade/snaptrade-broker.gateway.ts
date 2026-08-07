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
  WebullAccount,
} from '@0dtetrader/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BrokerExecutionScope,
  BrokerGateway,
  MARKET_DATA_PROVIDER,
  MarketDataProvider,
  ResolvedContractHint,
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
import { errors } from '../../common/api-exception';

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
    const { mode, clientId, consumerKey, accountId } = await this.credentialsFor(userId);
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
          clientId,
          consumerKey,
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
          clientId,
          consumerKey,
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
        // SnapTrade's preview endpoint returns an impact cost, not a quote —
        // there is no live bid/ask to report here (see estimatedMid above).
        bid: limitPrice ?? 0,
        ask: limitPrice ?? 0,
      },
      warnings: impact.warnings,
    };
  }

  async placeOrder(
    userId: string,
    order: OrderRequest,
    idempotencyKey: string,
    expectedMode?: TradingMode,
    heldQuantity?: number,
    _resolvedContract?: ResolvedContractHint,
    expectedScope?: BrokerExecutionScope,
  ): Promise<OrderResult> {
    const { mode, clientId, consumerKey, accountId } = await this.credentialsFor(userId);
    // See the Webull gateway: the mode read here selects paper vs live, so it
    // must agree with the one the caller validated against.
    if (expectedMode && mode !== expectedMode) {
      throw brokerErrors.orderRejected(
        `Account switched to ${mode} while this ${expectedMode} order was being placed — nothing was sent`,
      );
    }
    if (
      expectedScope &&
      (expectedScope.provider !== 'snaptrade' ||
        expectedScope.environment !== mode ||
        expectedScope.accountId !== accountId)
    ) {
      throw brokerErrors.orderRejected(
        'SnapTrade account selection changed while this bracket was armed — nothing was sent',
      );
    }
    const limitPrice = order.orderType === 'market' ? undefined : this.estimatedMid(order);

    if (order.assetClass === 'option') {
      // TradingService just read this exact account's position while applying
      // the close-size cap. Reuse that signed quantity so a selected-account
      // change cannot make the intent lookup drift to another account between
      // validation and send.
      const intent =
        heldQuantity !== undefined
          ? positionIntentFor(order.side, heldQuantity)
          : await this.optionPositionIntent(userId, order);
      const payload = buildOptionOrderPayload(
        accountId,
        order,
        limitPrice,
        order.side === 'buy' ? 'DEBIT' : 'CREDIT',
        intent,
      );
      const result = await this.client.placeOptionOrder(
        mode,
        clientId,
        consumerKey,
        accountId,
        payload,
      );
      const orderId = result.brokerage_order_id ?? idempotencyKey;
      const mapped = this.mapOrderResult(order, orderId, limitPrice);
      this.events.emit(userId, mapped, mode, {
        provider: 'snaptrade',
        accountId,
        brokerOrderId: result.brokerage_order_id ?? undefined,
        clientOrderId: idempotencyKey,
      });
      return mapped;
    }

    const payload = buildEquityOrderPayload(accountId, order, limitPrice, idempotencyKey);
    const result = await this.client.placeEquityOrder(mode, clientId, consumerKey, payload as any);
    const orderId = result.brokerage_order_id ?? idempotencyKey;
    const mapped = this.mapOrderResult(order, orderId, limitPrice);
    this.events.emit(userId, mapped, mode, {
      provider: 'snaptrade',
      accountId,
      brokerOrderId: result.brokerage_order_id ?? undefined,
      clientOrderId: idempotencyKey,
    });
    return mapped;
  }

  async cancelOrder(userId: string, orderId: string): Promise<void> {
    const { mode, clientId, consumerKey, accountId } = await this.credentialsFor(userId);
    const open = await this.getOpenOrders(userId);
    const target = open.find((o) => o.orderId === orderId);
    if (!target) throw brokerErrors.orderNotFound(orderId);

    await this.client.cancelOrder(mode, clientId, consumerKey, accountId, orderId);
    this.events.emit(userId, { ...target, status: 'cancelled' }, mode, {
      provider: 'snaptrade',
      accountId,
      brokerOrderId: orderId,
    });
  }

  async getPositions(userId: string, expectedScope?: BrokerExecutionScope): Promise<Position[]> {
    const { mode, clientId, consumerKey, accountId } = await this.credentialsFor(userId);
    if (
      expectedScope &&
      (expectedScope.provider !== 'snaptrade' ||
        expectedScope.environment !== mode ||
        expectedScope.accountId !== accountId)
    ) {
      throw brokerErrors.orderRejected(
        'SnapTrade account selection changed while this bracket was armed — positions were not read',
      );
    }
    const response = await this.client.getAllAccountPositions(
      mode,
      clientId,
      consumerKey,
      accountId,
    );
    return toPositions(response);
  }

  async getOpenOrders(userId: string): Promise<OrderResult[]> {
    const { mode, clientId, consumerKey, accountId } = await this.credentialsFor(userId);
    const orders = await this.client.getOpenOrders(mode, clientId, consumerKey, accountId);
    return orders
      .map((order) => toOrderResult(order))
      .filter((o) => o.status === 'submitted' || o.status === 'partially_filled');
  }

  async getRecentOrders(
    userId: string,
    since?: Date,
    expectedScope?: BrokerExecutionScope,
  ): Promise<OrderResult[]> {
    const { mode, clientId, consumerKey, accountId } = await this.credentialsFor(userId);
    if (
      expectedScope &&
      (expectedScope.provider !== 'snaptrade' ||
        expectedScope.environment !== mode ||
        expectedScope.accountId !== accountId)
    ) {
      throw brokerErrors.orderRejected(
        'SnapTrade account selection changed while the interrupted order was being reconciled',
      );
    }
    const days = since
      ? Math.max(1, Math.min(30, Math.ceil((Date.now() - since.getTime()) / 86_400_000) + 1))
      : 2;
    const orders = await this.client.getRecentOrders(mode, clientId, consumerKey, accountId, days);
    return orders
      .map((order) => toOrderResult(order))
      .filter((order) => !since || Date.parse(order.timestamp) >= since.getTime());
  }

  async reauthenticate(userId: string): Promise<TradingMode> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { tradingMode: true },
    });
    return (user?.tradingMode ?? 'live') as TradingMode;
  }

  // Account selection for SnapTrade goes through SnapTradeConnectionService
  // (register/authorize/list/select per connection), not this generic seam.
  async listAccounts(): Promise<WebullAccount[]> {
    return [];
  }

  async selectAccount(): Promise<void> {
    throw errors.badRequest(
      'UNSUPPORTED_ACCOUNT_SELECTION',
      'Account selection is not supported for SnapTrade',
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async credentialsFor(userId: string): Promise<{
    mode: TradingMode;
    clientId: string;
    consumerKey: string;
    accountId: string;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        tradingProvider: true,
        tradingMode: true,
      },
    });
    if (user?.tradingProvider !== 'snaptrade') {
      throw brokerErrors.authFailed('User is not configured for SnapTrade');
    }
    const mode = (user.tradingMode ?? 'live') as TradingMode;
    const connection = await this.prisma.brokerConnection.findUnique({
      where: { userId_provider_environment: { userId, provider: 'snaptrade', environment: mode } },
    });
    const accountId = connection?.selectedAccountId ?? connection?.accountIds[0] ?? null;
    if (!accountId) {
      throw brokerErrors.authFailed('No SnapTrade trading account selected');
    }
    const stored = await this.credentials.getDecrypted(userId, 'snaptrade', mode);
    if (!stored || stored.provider !== 'snaptrade') {
      throw brokerErrors.authFailed(
        'No SnapTrade credentials — save your Personal client ID/consumer key in Profile first',
      );
    }
    return { mode, clientId: stored.clientId, consumerKey: stored.consumerKey, accountId };
  }

  async executionScope(userId: string, expectedMode?: TradingMode): Promise<BrokerExecutionScope> {
    const { mode: environment, accountId } = await this.credentialsFor(userId);
    if (expectedMode && environment !== expectedMode) {
      throw brokerErrors.orderRejected(
        `Account switched to ${environment} while this ${expectedMode} order was being placed — nothing was sent`,
      );
    }
    return { provider: 'snaptrade', environment, accountId };
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
