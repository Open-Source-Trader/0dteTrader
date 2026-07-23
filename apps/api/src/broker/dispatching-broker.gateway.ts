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
} from '@0dtetrader/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { BrokerGateway } from './broker-gateway.interface';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly webull: BrokerGateway,
    private readonly alpaca: BrokerGateway,
  ) {}

  /** Resolve the gateway for a user from their stored trading provider. */
  private async gatewayFor(userId: string): Promise<BrokerGateway> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { tradingProvider: true },
    });
    return user?.tradingProvider === 'alpaca' ? this.alpaca : this.webull;
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
  ): Promise<OrderResult> {
    return (await this.gatewayFor(userId)).placeOrder(userId, order, idempotencyKey);
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
}
