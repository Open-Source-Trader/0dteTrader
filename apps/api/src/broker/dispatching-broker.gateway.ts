import { Injectable } from '@nestjs/common';
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
import { PrismaService } from '../prisma/prisma.service';
import { BrokerGateway } from './broker-gateway.interface';

/** How long a resolved provider is trusted before re-reading it from the DB. */
const PROVIDER_CACHE_TTL_MS = 30_000;

/**
 * Provider dispatch seam (docs/plans/alpaca-provider-plan.md §Phase2).
 *
 * `BROKER_GATEWAY` is still a single `BrokerGateway` token — every
 * existing consumer (trading.service, market-data.controller, stream.gateway,
 * the session controllers) injects it and calls methods with `userId`, so the
 * dispatch is invisible to them. This class reads the user's `tradingProvider`
 * and delegates each call to the Webull or Alpaca gateway; both gateways
 * remain internally self-contained (each resolves `tradingMode` itself).
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
    return provider === 'alpaca' ? this.alpaca : this.webull;
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
  ): Promise<OrderResult> {
    return (await this.gatewayFor(userId)).placeOrder(
      userId,
      order,
      idempotencyKey,
      expectedMode,
      heldQuantity,
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
