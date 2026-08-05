import {
  AccountSummary,
  Candle,
  CandleRequest,
  OptionContract,
  OptionsChain,
  OrderPreview,
  OrderRequest,
  OrderResult,
  Position,
  Quote,
  TradingMode,
  WebullAccount,
} from '@0dtetrader/shared-types';

/**
 * Injection token for the BrokerGateway (Webull OpenAPI). The gateway is a
 * per-request facade — every method receives `userId` and resolves that
 * user's credentials from the database. No user state is held on the
 * gateway instance. Multiple users share the same gateway singleton safely.
 */
export const BROKER_GATEWAY = 'BROKER_GATEWAY';

/**
 * The contract `TradingService.resolveAndValidate` already resolved from a
 * live chain fetch, handed to `placeOrder` so a gateway that resolves
 * contracts via its own chain/quote call (Webull) can skip repeating that
 * work seconds later for the same symbol. Optional: gateways that resolve
 * differently (or not at all, e.g. SnapTrade) are free to ignore it.
 */
export type ResolvedContractHint = OptionContract;

/**
 * Immutable execution identity used by unattended orders.  Environment alone
 * is not enough: a provider or selected brokerage account can change while a
 * chart order is armed, and routing the old order to the new account would be
 * a materially different trade.
 */
export interface BrokerExecutionScope {
  provider: 'webull' | 'alpaca' | 'snaptrade';
  environment: TradingMode;
  accountId: string;
}

/** An exact recovery may expose both provider aliases even though the public
 * OrderResult intentionally has one app-facing order id. The extra aliases
 * stay inside recovery/audit ingestion and are stripped before API return. */
export type RecoveredOrderResult = OrderResult & {
  brokerOrderId?: string;
  clientOrderId?: string;
};

/** Injection token for the MarketDataProvider seam. */
export const MARKET_DATA_PROVIDER = 'MARKET_DATA_PROVIDER';

/**
 * Thin market-data seam consumed by {@link SnapTradeBrokerGateway}.
 *
 * SnapTrade cannot supply candles or a bulk options chain. Rather than
 * duplicating that logic, the SnapTrade gateway injects a
 * {@link MarketDataProvider} and forwards its 3 data calls to it.
 *
 * The current binding prefers Alpaca when it has credentials and falls back
 * to Webull otherwise.
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
   *
   * `resolvedContract` is the contract `TradingService.resolveAndValidate`
   * already resolved from a live chain fetch moments earlier. A gateway that
   * would otherwise re-resolve via its own chain/quote call may reuse it
   * instead. Omitted, the gateway resolves it itself.
   */
  placeOrder(
    userId: string,
    order: OrderRequest,
    idempotencyKey: string,
    expectedMode?: TradingMode,
    heldQuantity?: number,
    resolvedContract?: ResolvedContractHint,
    expectedScope?: BrokerExecutionScope,
  ): Promise<OrderResult>;
  /** Resolve the provider, environment and selected brokerage account that a
   * placement would use right now. Gateways that cannot expose an account id
   * may omit this; callers then use the conservative provider default. */
  executionScope?(userId: string, expectedMode?: TradingMode): Promise<BrokerExecutionScope>;
  cancelOrder(userId: string, orderId: string): Promise<void>;
  getPositions(userId: string, expectedScope?: BrokerExecutionScope): Promise<Position[]>;
  getOpenOrders(userId: string): Promise<OrderResult[]>;
  /**
   * Every order the broker has on file (any status), optionally limited to
   * those placed at or after `since`. Backs history reconciliation for orders
   * the user placed directly on the broker rather than through this app,
   * which never reach {@link OrderEventsService} and so are never persisted
   * by their own path. Optional: not every gateway can list historical orders
   * cheaply yet, so `OrdersService` treats its absence as "nothing to
   * reconcile" rather than an error.
   */
  getRecentOrders?(
    userId: string,
    since?: Date,
    expectedScope?: BrokerExecutionScope,
  ): Promise<OrderResult[]>;
  /** Exact keyed recovery for providers that can query the deterministic
   * client-order id directly. `null` means the provider authoritatively says
   * no such order; `undefined` means this gateway does not support the exact
   * lookup and the caller may fall back to bounded history matching. */
  recoverOrder?(
    userId: string,
    idempotencyKey: string,
    expectedScope: BrokerExecutionScope,
  ): Promise<RecoveredOrderResult | null | undefined>;
  /**
   * Broker-reported account equity (current and prior-close), the
   * authoritative source for today's P&L. Optional: only brokers that expose
   * a previous-close equity reference implement it (Alpaca today); others
   * are treated as unsupported and `OrdersService`/clients fall back to a
   * locally-computed estimate.
   */
  getAccountSummary?(userId: string): Promise<AccountSummary | null>;
  /**
   * Drop the cached Webull client/token for the user's current trading mode
   * and mint a fresh access token. Returns the mode it applied to.
   */
  reauthenticate(userId: string): Promise<TradingMode>;
  listAccounts(userId: string, environment: TradingMode): Promise<WebullAccount[]>;
  selectAccount(userId: string, environment: TradingMode, accountId: string): Promise<void>;
}
