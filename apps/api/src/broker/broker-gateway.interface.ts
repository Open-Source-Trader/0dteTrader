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

/** Injection token for the BrokerGateway (Webull OpenAPI). */
export const BROKER_GATEWAY = 'BROKER_GATEWAY';

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
  listAccounts(userId: string, environment: TradingMode): Promise<WebullAccount[]>;
  selectAccount(userId: string, environment: TradingMode, accountId: string): Promise<void>;
}
