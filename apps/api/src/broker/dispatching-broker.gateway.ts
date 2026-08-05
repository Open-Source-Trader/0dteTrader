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
import { BrokerGateway, ResolvedContractHint } from './broker-gateway.interface';

/** How long a resolved provider is trusted before re-reading it from the DB. */
const PROVIDER_CACHE_TTL_MS = 30_000;

/**
 * Provider dispatch seam. Routes every call to the user's selected trading
 * provider based on their `tradingProvider`. SnapTrade users get the
 * SnapTrade gateway (which delegates market-data to the configured legacy
 * provider and handles execution via the SnapTrade SDK).
 */
@Injectable()
export class DispatchingBrokerGateway implements BrokerGateway {
  /**
   * Every call (quote streaming, the 1s order-status poll, ...) otherwise hit
   * Prisma just to learn which provider a user is on — a value that changes
   * only through a deliberate Profile action. Cached per user with a short TTL
   * rather than invalidated on write: cheap, self-healing if a provider
   * switch ever happens mid-flight, and needs no cross-module wiring into
   * UsersService.setTradingProvider.
   */
  private readonly providerCache = new Map<
    string,
    { provider: string | null; expiresAt: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly webull: BrokerGateway,
    private readonly alpaca: BrokerGateway,
    private readonly snaptrade: BrokerGateway,
  ) {}

  /** Resolve the gateway for a user from their stored trading provider. */
  private async gatewayFor(userId: string): Promise<BrokerGateway> {
    const cached = this.providerCache.get(userId);
    let provider: string | null;
    if (cached && cached.expiresAt > Date.now()) {
      provider = cached.provider;
    } else {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { tradingProvider: true },
      });
      provider = user?.tradingProvider ?? null;
      this.providerCache.set(userId, { provider, expiresAt: Date.now() + PROVIDER_CACHE_TTL_MS });
    }
    if (provider === 'alpaca') return this.alpaca;
    if (provider === 'snaptrade') return this.snaptrade;
    return this.webull;
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
  ): Promise<OrderResult> {
    return (await this.gatewayFor(userId)).placeOrder(
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

  async getPositions(userId: string): Promise<Position[]> {
    return (await this.gatewayFor(userId)).getPositions(userId);
  }

  async getOpenOrders(userId: string): Promise<OrderResult[]> {
    return (await this.gatewayFor(userId)).getOpenOrders(userId);
  }

  async getRecentOrders(userId: string, since?: Date): Promise<OrderResult[]> {
    const gateway = await this.gatewayFor(userId);
    return (await gateway.getRecentOrders?.(userId, since)) ?? [];
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
