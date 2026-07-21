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

/**
 * Injection token for the BrokerGateway (Webull OpenAPI). The gateway is a
 * per-request facade — every method receives `userId` and resolves that
 * user's credentials from the database. No user state is held on the
 * gateway instance. Multiple users share the same gateway singleton safely.
 */
export const BROKER_GATEWAY = 'BROKER_GATEWAY';

/** Injection token for the MarketDataProvider seam. */
export const MARKET_DATA_PROVIDER = 'MARKET_DATA_PROVIDER';

/**
 * Thin market-data seam consumed by {@link SnapTradeBrokerGateway}.
 *
 * SnapTrade cannot supply candles or a bulk options chain. Rather than
 * duplicating that logic, the SnapTrade gateway injects a
 * {@link MarketDataProvider} and forwards its 3 data calls to it. In Phase 2
 * the binding will resolve to whichever legacy provider is configured for
 * the user (Webull or Alpaca); until then `MARKET_DATA_PROVIDER` is bound
 * to {@link WebullBrokerGateway} as a safe default.
 *
 * Both {@link WebullBrokerGateway} and {@link AlpacaBrokerGateway} satisfy
 * this interface natively — Alpaca via the Alpaca SDK's stock/option bars
 * and chain endpoints.
 */
export interface MarketDataProvider {
  getQuote(userId: string, symbol: string): Promise<Quote>;
  getCandles(userId: string, symbol: string, req: CandleRequest): Promise<Candle[]>;
  getOptionsChain(userId: string, symbol: string, expiration?: string): Promise<OptionsChain>;
}

/**
 * The key seam (docs/ARCHITECTURE.md §2). All iOS-facing endpoints depend only
 * on this interface; the single implementation is the Webull gateway (live vs
 * practice selects the live vs paper-trading OpenAPI hosts per user).
 */
export interface BrokerGateway {
  getQuote(userId: string, symbol: string): Promise<Quote>;
  getCandles(userId: string, symbol: string, req: CandleRequest): Promise<Candle[]>;
  getOptionsChain(userId: string, symbol: string, expiration?: string): Promise<OptionsChain>;
  previewOrder(userId: string, order: OrderRequest): Promise<OrderPreview>;
  placeOrder(userId: string, order: OrderRequest, idempotencyKey: string): Promise<OrderResult>;
  cancelOrder(userId: string, orderId: string): Promise<void>;
  getPositions(userId: string): Promise<Position[]>;
  getOpenOrders(userId: string): Promise<OrderResult[]>;
  /**
   * Drop the cached Webull client/token for the user's current trading mode
   * and mint a fresh access token. Returns the mode it applied to.
   */
  reauthenticate(userId: string): Promise<TradingMode>;
}
