import { Injectable } from '@nestjs/common';
import {
  AccountSummary,
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
import { PrismaService } from '../prisma/prisma.service';
import { brokerErrors } from '../common/broker-error';
import {
  BrokerExecutionScope,
  BrokerGateway,
  RecoveredOrderResult,
  ResolvedContractHint,
} from './broker-gateway.interface';

/**
 * Provider dispatch seam. Routes every call to the user's selected trading
 * provider based on their `tradingProvider`. SnapTrade users get the
 * SnapTrade gateway (which delegates market-data to the configured legacy
 * provider and handles execution via the SnapTrade SDK).
 */
@Injectable()
export class DispatchingBrokerGateway implements BrokerGateway {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webull: BrokerGateway,
    private readonly alpaca: BrokerGateway,
    private readonly snaptrade: BrokerGateway,
  ) {}

  private gatewayForProvider(provider: string | null): BrokerGateway {
    if (provider === 'alpaca') return this.alpaca;
    if (provider === 'snaptrade') return this.snaptrade;
    return this.webull;
  }

  /** Resolve the gateway for a user from their stored trading provider. */
  private async gatewayFor(userId: string): Promise<BrokerGateway> {
    // Provider selection is a routing identity, not a display preference.
    // Read it fresh so a switch cannot leave quotes/positions — and especially
    // a placement — talking to the previous provider for a cache interval.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { tradingProvider: true },
    });
    const provider = user?.tradingProvider ?? null;
    return this.gatewayForProvider(provider);
  }

  /** Deliberately bypasses the provider cache. An unattended order uses this
   * value as a money-boundary assertion, where a 30-second stale route is not
   * acceptable. */
  async executionScope(userId: string, expectedMode?: TradingMode): Promise<BrokerExecutionScope> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { tradingProvider: true, tradingMode: true },
    });
    const provider =
      user?.tradingProvider === 'alpaca' || user?.tradingProvider === 'snaptrade'
        ? user.tradingProvider
        : 'webull';
    const environment: TradingMode = user?.tradingMode === 'practice' ? 'practice' : 'live';
    if (expectedMode && expectedMode !== environment) {
      throw brokerErrors.orderRejected(
        `Account switched to ${environment} while this ${expectedMode} order was being placed — nothing was sent`,
      );
    }
    const gateway = this.gatewayForProvider(provider);
    const childScope = await gateway.executionScope?.(userId, environment);
    return childScope ?? { provider, environment, accountId: 'default' };
  }

  async getQuote(userId: string, symbol: string): Promise<Quote> {
    return (await this.gatewayFor(userId)).getQuote(userId, symbol);
  }

  async getCandles(userId: string, symbol: string, req: CandleRequest): Promise<Candle[]> {
    return (await this.gatewayFor(userId)).getCandles(userId, symbol, req);
  }

  async getOptionsChain(
    userId: string,
    symbol: string,
    expiration?: string,
  ): Promise<OptionsChain> {
    return (await this.gatewayFor(userId)).getOptionsChain(userId, symbol, expiration);
  }

  async previewOrder(userId: string, order: OrderRequest): Promise<OrderPreview> {
    return (await this.gatewayFor(userId)).previewOrder(userId, order);
  }

  async placeOrder(
    userId: string,
    order: OrderRequest,
    idempotencyKey: string,
    expectedMode?: TradingMode,
    heldQuantity?: number,
    resolvedContract?: ResolvedContractHint,
    expectedScope?: BrokerExecutionScope,
  ): Promise<OrderResult> {
    const scope = expectedScope ?? null;
    const current = scope ? await this.executionScope(userId, expectedMode) : null;
    const gateway = current
      ? this.gatewayForProvider(current.provider)
      : await this.gatewayFor(userId);
    if (scope && current) {
      if (
        current.provider !== scope.provider ||
        current.environment !== scope.environment ||
        current.accountId !== scope.accountId
      ) {
        throw brokerErrors.orderRejected(
          'Broker provider or selected account changed while this bracket was armed — nothing was sent',
        );
      }
    }
    return expectedScope
      ? gateway.placeOrder(
          userId,
          order,
          idempotencyKey,
          expectedMode,
          heldQuantity,
          resolvedContract,
          expectedScope,
        )
      : gateway.placeOrder(
          userId,
          order,
          idempotencyKey,
          expectedMode,
          heldQuantity,
          resolvedContract,
        );
  }

  async cancelOrder(userId: string, orderId: string): Promise<void> {
    return (await this.gatewayFor(userId)).cancelOrder(userId, orderId);
  }

  async getPositions(userId: string, expectedScope?: BrokerExecutionScope): Promise<Position[]> {
    if (!expectedScope) return (await this.gatewayFor(userId)).getPositions(userId);
    const current = await this.executionScope(userId, expectedScope.environment);
    if (
      current.provider !== expectedScope.provider ||
      current.accountId !== expectedScope.accountId
    ) {
      throw brokerErrors.orderRejected(
        'Broker provider or selected account changed while this bracket was armed — positions were not read',
      );
    }
    return this.gatewayForProvider(current.provider).getPositions(userId, expectedScope);
  }

  async getOpenOrders(userId: string): Promise<OrderResult[]> {
    return (await this.gatewayFor(userId)).getOpenOrders(userId);
  }

  async getRecentOrders(
    userId: string,
    since?: Date,
    expectedScope?: BrokerExecutionScope,
  ): Promise<OrderResult[]> {
    const current = expectedScope
      ? await this.executionScope(userId, expectedScope.environment)
      : null;
    if (
      expectedScope &&
      current &&
      (current.provider !== expectedScope.provider ||
        current.environment !== expectedScope.environment ||
        current.accountId !== expectedScope.accountId)
    ) {
      throw brokerErrors.orderRejected(
        'Broker provider or selected account changed while the interrupted order was being reconciled',
      );
    }
    const gateway = current
      ? this.gatewayForProvider(current.provider)
      : await this.gatewayFor(userId);
    if (!gateway.getRecentOrders) {
      throw brokerErrors.unavailable(
        'This broker cannot confirm historical orders; interrupted placement cannot be retried safely',
      );
    }
    return gateway.getRecentOrders(userId, since, expectedScope);
  }

  async recoverOrder(
    userId: string,
    idempotencyKey: string,
    expectedScope: BrokerExecutionScope,
  ): Promise<RecoveredOrderResult | null | undefined> {
    const current = await this.executionScope(userId, expectedScope.environment);
    if (
      current.provider !== expectedScope.provider ||
      current.environment !== expectedScope.environment ||
      current.accountId !== expectedScope.accountId
    ) {
      throw brokerErrors.orderRejected(
        'Broker provider or selected account changed while the interrupted order was being reconciled',
      );
    }
    const gateway = this.gatewayForProvider(current.provider);
    return gateway.recoverOrder?.(userId, idempotencyKey, expectedScope);
  }

  async getAccountSummary(userId: string): Promise<AccountSummary | null> {
    const gateway = await this.gatewayFor(userId);
    return (await gateway.getAccountSummary?.(userId)) ?? null;
  }

  async reauthenticate(userId: string): Promise<TradingMode> {
    return (await this.gatewayFor(userId)).reauthenticate(userId);
  }

  async listAccounts(userId: string, environment: TradingMode): Promise<WebullAccount[]> {
    return (await this.gatewayFor(userId)).listAccounts(userId, environment);
  }

  async selectAccount(userId: string, environment: TradingMode, accountId: string): Promise<void> {
    return (await this.gatewayFor(userId)).selectAccount(userId, environment, accountId);
  }
}
