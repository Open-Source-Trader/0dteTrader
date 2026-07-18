import {
  Candle,
  CandleRequest,
  OptionsChain,
  OrderPreview,
  OrderRequest,
  OrderResult,
  Position,
  Quote,
} from '@0dtetrader/shared-types';

/** Injection token for the active BrokerGateway (BROKER_GATEWAY=mock|webull). */
export const BROKER_GATEWAY = 'BROKER_GATEWAY';

/**
 * The key seam (docs/ARCHITECTURE.md §2). All iOS-facing endpoints depend only
 * on this interface; the implementation is selected by BROKER_GATEWAY.
 */
export interface BrokerGateway {
  getQuote(userId: string, symbol: string): Promise<Quote>;
  getCandles(
    userId: string,
    symbol: string,
    req: CandleRequest,
  ): Promise<Candle[]>;
  getOptionsChain(
    userId: string,
    symbol: string,
    expiration?: string,
  ): Promise<OptionsChain>;
  previewOrder(userId: string, order: OrderRequest): Promise<OrderPreview>;
  placeOrder(
    userId: string,
    order: OrderRequest,
    idempotencyKey: string,
  ): Promise<OrderResult>;
  cancelOrder(userId: string, orderId: string): Promise<void>;
  getPositions(userId: string): Promise<Position[]>;
  getOpenOrders(userId: string): Promise<OrderResult[]>;
}
