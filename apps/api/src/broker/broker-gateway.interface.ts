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
  /**
   * `expectedMode` pins live vs practice for this one placement. Every gateway
   * otherwise re-derives the mode from the database each time it builds a
   * client, so a mode flip between the caller's check and the send would route
   * the order to the other environment. Passing it makes the gateway refuse
   * rather than silently re-decide.
   *
   * `heldQuantity` is the position already held in this contract, when the
   * caller has just read it (`TradingService.capToPosition` always has):
   * lets the gateway skip its own positions fetch when deciding open vs close
   * intent. Omitted, the gateway looks it up itself.
   */
  placeOrder(
    userId: string,
    order: OrderRequest,
    idempotencyKey: string,
    expectedMode?: TradingMode,
    heldQuantity?: number,
  ): Promise<OrderResult>;
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
