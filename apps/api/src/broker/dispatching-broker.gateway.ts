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

  /** Resolve the gateway for a user from their stored trading provider. */
  private async gatewayFor(userId: string): Promise<BrokerGateway> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { tradingProvider: true },
    });
    if (user?.tradingProvider === 'alpaca') return this.alpaca;
    if (user?.tradingProvider === 'snaptrade') return this.snaptrade;
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
