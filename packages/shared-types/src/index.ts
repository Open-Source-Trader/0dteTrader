/**
 * Shared DTO/domain types for 0dteTrader.
 * Mirrors docs/openapi.yaml — the single source of truth for the API contract.
 * Consumed by apps/api (and later apps/ios codegen).
 */

// ---------------------------------------------------------------------------
// Enums / string unions
// ---------------------------------------------------------------------------

export type AssetClass = 'option';
export type TradingMode = 'live' | 'practice';
/** Broker a user trades through. */
export type BrokerProvider = 'webull' | 'alpaca' | 'snaptrade';
/** Providers a credential row can be stored for. Tradier is a market-data
 *  API key (needed alongside Webull, which has no index data), not a trading
 *  provider — it is storable but never selectable as `tradingProvider`. */
export type CredentialProvider = BrokerProvider | 'tradier';
export type OrderSide = 'buy' | 'sell';
/**
 * Execution types a resting chart-order line may carry.
 *
 * Deliberately narrower than `OrderType`, and deliberately its own name rather
 * than an inline union: a line is fired by `ChartOrderWatcherService` with
 * nobody watching and nothing on screen to type a price into, so the variants
 * that need a human-supplied number cannot reach it. Both platforms mirror this
 * split, and the compiler is what enforces it — see `narrowToChartOrderType`.
 */
export type ChartOrderType = 'mid' | 'market';

/**
 * How the trade panel prices an order.
 *
 * Only `custom` carries a client-supplied price (`OrderRequest.limitPrice`);
 * `bid`, `mid` and `ask` are resolved server-side from the server's own quote
 * at execution time, exactly as `mid` always was. Four of the five therefore
 * add no new trust boundary, and the price validation only has to guard the one
 * path where a human typed a number.
 *
 * `mid` and `market` keep their spellings, so rows and settings already
 * persisted as either still decode.
 */
export type OrderType = ChartOrderType | 'custom' | 'bid' | 'ask';

/** The four variants that place a limit order; the fifth, `market`, does not. */
export function isLimitOrderType(orderType: OrderType): boolean {
  return orderType !== 'market';
}

/**
 * The chart line's execution type for a panel selection.
 *
 * The three price-carrying variants collapse onto `mid` — the server-computed
 * limit — because a line fires unattended: a bid/ask read at arming time would
 * be stale by the time the level is crossed, and a custom price belongs to the
 * contract and the moment it was typed for.
 */
export function narrowToChartOrderType(orderType: OrderType): ChartOrderType {
  return orderType === 'market' ? 'market' : 'mid';
}

export type OptionType = 'call' | 'put';
export type SelectionMode = 'auto_otm' | 'explicit';
export type OrderStatus = 'submitted' | 'filled' | 'partially_filled' | 'cancelled' | 'rejected';
export type ChartOrderKind = 'limit' | 'target' | 'stop';
export type ChartOrderStatus =
  'working' | 'triggered' | 'filled' | 'cancelled' | 'failed' | 'expired';
/** Which side of its trigger the underlying sat on when the order was armed. */
export type ChartOrderArmedSide = 'above' | 'below';
export type CandleInterval = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w';
export type TickInterval = '10t' | '25t' | '50t' | '100t' | '250t';
export type ChartInterval = CandleInterval | TickInterval;

// ---------------------------------------------------------------------------
// Options analytics
// ---------------------------------------------------------------------------

export const OPTIONS_ANALYTICS_EXPOSURE_UNIT = '$ delta change per 1% underlying move' as const;

export type OptionsAnalyticsFeedMode = 'realtime' | 'delayed' | 'sandbox' | 'unknown';

export type OptionsAnalyticsCacheStatus = 'fresh' | 'memory-cache' | 'stale-fallback';

export interface OptionsAnalyticsScope {
  symbol: string;
  /** Exact option product/root selected for the calculation (for example SPX or SPXW). */
  rootSymbol: string;
  /** Opening-print (AM) or market-close (PM) settlement. */
  settlementStyle: 'am' | 'pm';
  /** YYYY-MM-DD. */
  expiration: string;
  /** ISO-8601 date-time. */
  observedAt: string;
  /** ISO-8601 date-time. */
  settlementAt: string;
  spot: number;
  forward: number;
}

export interface OptionsAnalyticsCoverage {
  contractsTotal: number;
  contractsIncluded: number;
  ratio: number;
}

export interface OptionsAnalyticsQuality {
  /** ISO-8601 date-time, or null when the source did not provide it. */
  quoteAsOf: string | null;
  /** ISO-8601 date-time, or null when the source did not provide it. */
  greeksAsOf: string | null;
  /** YYYY-MM-DD, or null when the effective date cannot be established. */
  oiEffectiveDate: string | null;
  feedMode: OptionsAnalyticsFeedMode;
  coverage: OptionsAnalyticsCoverage;
  status: 'complete' | 'partial';
  warnings: string[];
  calculationVersion: string;
  cacheStatus: OptionsAnalyticsCacheStatus;
}

export interface OptionsAnalyticsStrikeLeg {
  openInterest: number;
  volume: number;
  impliedVolatility: number | null;
  delta: number | null;
  gamma: number | null;
  gammaExposure: number | null;
  deltaNotional: number | null;
  markedOiValue: number | null;
  relativeSpread: number | null;
  roundTripCost: number | null;
  bidSize: number;
  askSize: number;
  multiplier: number;
}

export interface OptionsAnalyticsStrike {
  strike: number;
  call: OptionsAnalyticsStrikeLeg | null;
  put: OptionsAnalyticsStrikeLeg | null;
  grossGammaExposure: number | null;
  totalOpenInterest: number;
}

export interface OptionsAnalyticsStructure {
  callGammaExposure: number | null;
  putGammaExposure: number | null;
  grossGammaExposure: number | null;
  callDeltaNotional: number | null;
  putDeltaNotional: number | null;
  callWall: number | null;
  putWall: number | null;
  grossGammaConcentration: number | null;
  maxOpenInterestStrike: number | null;
}

export interface OptionsAnalyticsDealerProxyScenario {
  assumption: string;
  gammaExposure: number;
  deltaNotional: number;
  strikeGammaExposures: Array<{ strike: number; gammaExposure: number | null }>;
  gammaRoots: number[];
  primaryGammaRoot: number | null;
}

export interface OptionsAnalyticsScenarios {
  callPutDealerProxy: OptionsAnalyticsDealerProxyScenario | null;
}

export interface OptionsAnalyticsImpliedRange {
  lower: number;
  upper: number;
  confidence: 0.68;
  label: 'model-implied 68% range';
  atmIv: number;
  straddleLower: number;
  straddleUpper: number;
}

/** Canonical GET /v1/market/options-analytics response. */
export interface OptionsAnalyticsSnapshot {
  scope: OptionsAnalyticsScope;
  exposureUnit: typeof OPTIONS_ANALYTICS_EXPOSURE_UNIT;
  quality: OptionsAnalyticsQuality;
  structure: OptionsAnalyticsStructure;
  scenarios: OptionsAnalyticsScenarios;
  impliedRange: OptionsAnalyticsImpliedRange | null;
  strikes: OptionsAnalyticsStrike[];
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface Credentials {
  email: string;
  password: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime in seconds. */
  expiresIn: number;
}

export interface RefreshRequest {
  refreshToken: string;
}

// ---------------------------------------------------------------------------
// Profile & credentials
// ---------------------------------------------------------------------------

export interface Me {
  id: string;
  email: string;
  tradingDisabled: boolean;
  tradingMode: TradingMode;
  /** Active trading provider chosen by the user (default 'webull'). */
  tradingProvider: BrokerProvider;
  /** Live Webull credentials are stored. */
  webullConfigured: boolean;
  /** Practice (paper) Webull credentials are stored. */
  webullPracticeConfigured: boolean;
  /** Live account id (auto-discovered via account/list); null until known. */
  webullAccountId: string | null;
  /** Practice account id; null until known. */
  webullPracticeAccountId: string | null;
  /** Live Alpaca credentials are stored. */
  alpacaConfigured?: boolean;
  /** Practice (paper) Alpaca credentials are stored. */
  alpacaPracticeConfigured?: boolean;
  /** Live Alpaca account id (key-scoped; null until discovered). */
  alpacaAccountId?: string | null;
  /** Practice Alpaca account id; null until known. */
  alpacaPracticeAccountId?: string | null;
  /** Live Tradier API key is stored (market data alongside Webull). */
  tradierConfigured?: boolean;
  /** Sandbox (practice) Tradier API key is stored. */
  tradierPracticeConfigured?: boolean;
  /** Live SnapTrade Personal clientId/consumerKey are stored. */
  snaptradeKeyConfigured?: boolean;
  /** Practice SnapTrade Personal clientId/consumerKey are stored. */
  snaptradeKeyPracticeConfigured?: boolean;
  /** Live SnapTrade brokerage connection is active. */
  snaptradeConfigured?: boolean;
  /** Practice SnapTrade brokerage connection is active. */
  snaptradePracticeConfigured?: boolean;
  /** Live SnapTrade trading account id (chosen from connected accounts). */
  snaptradeAccountId?: string | null;
  /** Practice SnapTrade trading account id; null until chosen. */
  snaptradePracticeAccountId?: string | null;
}

export interface WebullAccount {
  accountId: string;
  accountType?: string;
  accountName?: string;
}

export interface WebullCredentialsInput {
  /** Present only on the discriminated union; omitted by the legacy DTO. */
  provider?: 'webull';
  appKey: string;
  appSecret: string;
  /**
   * Optional manual override. Normally omitted — the account id is
   * auto-discovered via GET /openapi/account/list after the first
   * successful authentication (the official Webull flow).
   */
  accountId?: string;
  /** Environment this credential set belongs to; defaults to 'live'. */
  environment?: TradingMode;
}

/** Decrypted, in-memory secret shapes keyed by provider. */
export interface WebullSecrets {
  provider: 'webull';
  appKey: string;
  appSecret: string;
  accountId?: string;
}
export interface AlpacaSecrets {
  provider: 'alpaca';
  apiKey: string;
  apiSecret: string;
}
/** Tradier auth is a single bearer token — no secret pair, no account id. */
export interface TradierSecrets {
  provider: 'tradier';
  apiKey: string;
}
/** SnapTrade Personal client ID + consumer key — the user's own SnapTrade identity. */
export interface SnapTradeSecrets {
  provider: 'snaptrade';
  clientId: string;
  consumerKey: string;
}
export type BrokerSecrets = WebullSecrets | AlpacaSecrets | TradierSecrets | SnapTradeSecrets;

/** Provider-scoped credential input from the client. */
export interface AlpacaCredentialsInput {
  provider: 'alpaca';
  apiKey: string;
  apiSecret: string;
  environment?: TradingMode;
}
export interface TradierCredentialsInput {
  provider: 'tradier';
  apiKey: string;
  environment?: TradingMode;
}
/** SnapTrade Personal client ID + consumer key — user-entered, write-only, like Alpaca. */
export interface SnapTradeCredentialsInput {
  provider: 'snaptrade';
  clientId: string;
  consumerKey: string;
  environment?: TradingMode;
}
export type BrokerCredentialsInput =
  | WebullCredentialsInput
  | AlpacaCredentialsInput
  | TradierCredentialsInput
  | SnapTradeCredentialsInput;

export interface WebullCredentialsSaved {
  webullConfigured: true;
  environment: TradingMode;
}

export interface WebullSessionRefreshed {
  refreshed: true;
  /** Trading mode the fresh token was minted for (the user's current mode). */
  environment: TradingMode;
}

export interface BrokerCredentialsSaved {
  provider: CredentialProvider;
  configured: true;
  environment: TradingMode;
}

export interface BrokerSessionRefreshed {
  provider: BrokerProvider;
  refreshed: true;
  environment: TradingMode;
}

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  bidSize: number;
  askSize: number;
  volume: number;
  /** ISO-8601 date-time. */
  timestamp: string;
}

export interface Candle {
  /** ISO-8601 date-time of bucket start. */
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleRequest {
  interval: CandleInterval;
  /** ISO-8601 date-time; optional range start. */
  from?: string;
  /** ISO-8601 date-time; optional range end. */
  to?: string;
}

export interface OptionContract {
  symbol: string;
  underlying: string;
  /** YYYY-MM-DD. */
  expiration: string;
  strike: number;
  optionType: OptionType;
  bid: number;
  ask: number;
  last: number;
}

export interface OptionsChain {
  underlying: string;
  underlyingPrice: number;
  /** YYYY-MM-DD list, ascending (nearest first) — every expiration listed
   *  for this underlying, NOT all of which `contracts` covers. */
  expirations: string[];
  /** Which expiration `contracts` actually holds (the requested one, or the
   *  nearest when none was requested) — `contracts` covers exactly this one
   *  date, never all of `expirations`. Optional only so older server
   *  responses still decode; every current source populates it. */
  contractsExpiration?: string;
  contracts: OptionContract[];
}

// ---------------------------------------------------------------------------
// Trading
// ---------------------------------------------------------------------------

export interface OrderSelection {
  mode: SelectionMode;
  /** Required for auto_otm and for explicit option orders. */
  optionType?: OptionType;
  /** YYYY-MM-DD; defaults to the nearest expiration. */
  expiration?: string;
  /** Explicit option orders only. */
  strike?: number;
}

export interface OrderRequest {
  underlying: string;
  assetClass: AssetClass;
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
  /**
   * The price to work the limit at. Required when `orderType` is `custom` and
   * rejected otherwise — every other variant is priced from the server's own
   * quote, so accepting a number alongside them would be accepting one the
   * server then ignores.
   */
  limitPrice?: number;
  selection: OrderSelection;
}

export interface OrderPreview {
  resolved: {
    contractSymbol: string;
    price: number;
    estBuyingPower: number;
    /**
     * The quote the price was resolved against. Returned so the confirm sheet
     * can print a custom limit next to the live spread — with a typed price the
     * sheet is the last place a wrong number can be caught, and a number with
     * nothing to compare it to catches nothing.
     */
    bid: number;
    ask: number;
  };
  warnings: string[];
}

export interface OrderResult {
  orderId: string;
  status: OrderStatus;
  contractSymbol: string;
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
  limitPrice?: number;
  filledPrice?: number;
  /** Executed quantity when the broker reports it (partial fills). Absent
   *  when the broker gives only the order quantity. */
  filledQuantity?: number;
  /** ISO-8601 date-time. */
  timestamp: string;
}

export interface Position {
  symbol: string;
  assetClass: AssetClass;
  quantity: number;
  avgPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  /** Contract multiplier (options: 100). Lets clients recompute P/L from live quotes. */
  multiplier: number;
  /**
   * Quantity-weighted price of the UNDERLYING across the fills that opened this
   * position — the level the chart's entry line is drawn at. Absent for
   * positions opened before this was recorded, or outside the app.
   */
  underlyingEntryPrice?: number;
}

/** A historical order with the realized P/L its fill produced (closing fills only). */
export interface TradeHistoryEntry extends OrderResult {
  /** Realized P/L from the position this fill closed; null for opening fills and non-fills. */
  realizedPnl: number | null;
}

export interface TradeHistory {
  /** Newest first. */
  entries: TradeHistoryEntry[];
  /** Sum of realized P/L across all closing fills. */
  totalRealizedPnl: number;
}

// ---------------------------------------------------------------------------
// Chart trading (docs/ARCHITECTURE.md — order lines)
// ---------------------------------------------------------------------------

/**
 * A resting order line drawn on the candle chart. The broker never sees it:
 * the level is watched against the UNDERLYING's price, and a crossing fires a
 * normal `mid`/`market` option order. Both the client and a server-side watcher
 * are armed; they converge because the fire uses a deterministic idempotency
 * key derived from `id`.
 */
export interface ChartOrder {
  id: string;
  /** Chart symbol whose price arms the trigger (for example SPY), not the contract. */
  underlying: string;
  /** Level on the underlying that fires the order. */
  triggerPrice: number;
  /**
   * The underlying's price when the order was armed (created, or moved).
   * Firing tests the segment armPrice → last, so a gap, an app restart, or a
   * watcher failover cannot step over a level unnoticed. Never equal to
   * `triggerPrice` — the server rejects that, since the side would be undefined.
   */
  armPrice: number;
  side: OrderSide;
  quantity: number;
  /**
   * Execution type used when the level is crossed. Owned by this order, not by
   * the trade panel: a resting line must not change behaviour because a panel
   * toggle moved. Rendered on the line and tappable to flip.
   */
  orderType: ChartOrderType;
  kind: ChartOrderKind;
  optionType: OptionType;
  /** YYYY-MM-DD. */
  expiration: string;
  strike: number;
  contractSymbol: string;
  /** Shared by the target and stop of one position; firing either cancels the other. */
  ocoGroupId: string | null;
  status: ChartOrderStatus;
  /** ISO-8601 date-time. */
  createdAt: string;
  /** ISO-8601 date-time; the contract's expiration close. Past this the order expires unfilled. */
  expiresAt: string;
  /** ISO-8601 date-time; set when the level was crossed and the order was sent. */
  triggeredAt: string | null;
  /** Broker order id once sent. */
  brokerOrderId: string | null;
  /** Populated when the fire attempt failed, so the line can show why. */
  lastError: string | null;
}

/** Client → server create payload. The server resolves the contract, arm price,
 *  and expiry itself; client-supplied strikes are advisory (see TradingService). */
export interface ChartOrderDraft {
  underlying: string;
  triggerPrice: number;
  side: OrderSide;
  quantity: number;
  orderType: ChartOrderType;
  kind: ChartOrderKind;
  optionType: OptionType;
  expiration: string;
  strike: number;
  ocoGroupId?: string | null;
}

/** Client → server edit payload. Every field is optional; only `working` orders accept it. */
export interface ChartOrderPatch {
  /** Re-arms the order: `armPrice` is re-read from the live quote. */
  triggerPrice?: number;
  quantity?: number;
  orderType?: ChartOrderType;
}

/** The side of the trigger the order is waiting to be crossed *from*. */
export function chartOrderArmedSide(
  order: Pick<ChartOrder, 'armPrice' | 'triggerPrice'>,
): ChartOrderArmedSide {
  return order.armPrice >= order.triggerPrice ? 'above' : 'below';
}

/**
 * Whether a move from `previousPrice` to `currentPrice` crosses the order's
 * trigger from the side it was armed on.
 *
 * Callers pass the last price they actually observed as `previousPrice`, or
 * `order.armPrice` when they have not observed one yet — that is what makes a
 * restart or a missed poll safe. Testing the armed side (rather than a bare
 * crossing) is what stops a buy limit placed below an already-lower price from
 * firing the instant it is created.
 */
export function chartOrderCrossed(
  order: Pick<ChartOrder, 'armPrice' | 'triggerPrice'>,
  previousPrice: number,
  currentPrice: number,
): boolean {
  if (!Number.isFinite(previousPrice) || !Number.isFinite(currentPrice)) return false;
  return chartOrderArmedSide(order) === 'above'
    ? previousPrice >= order.triggerPrice && currentPrice <= order.triggerPrice
    : previousPrice <= order.triggerPrice && currentPrice >= order.triggerPrice;
}

/**
 * The direction a position profits in, as a sign on the UNDERLYING.
 *
 * This is why a bracket cannot simply map screen-up to "target": a long put
 * gains when the underlying falls, so its target sits BELOW the entry line and
 * its stop above. Long call → +1, long put → -1, and a short position inverts.
 */
export function positionProfitDirection(optionType: OptionType, quantity: number): 1 | -1 {
  const long = quantity >= 0;
  const callish = optionType === 'call';
  return long === callish ? 1 : -1;
}

/** Whether a bracket leg dragged to `price` from an entry at `entryPrice` is the target or the stop. */
export function bracketKindFor(
  optionType: OptionType,
  quantity: number,
  entryPrice: number,
  price: number,
): 'target' | 'stop' {
  const profitable = (price - entryPrice) * positionProfitDirection(optionType, quantity) > 0;
  return profitable ? 'target' : 'stop';
}

// ---------------------------------------------------------------------------
// Errors & WebSocket protocol
// ---------------------------------------------------------------------------

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

export interface StreamSubscribeMessage {
  type: 'subscribe' | 'unsubscribe';
  symbols: string[];
}

export interface StreamQuoteMessage {
  type: 'quote';
  data: Quote;
}

export interface StreamOrderUpdateMessage {
  type: 'orderUpdate';
  data: OrderResult;
}

/** Server-side watcher fired, expired, or reconciled a chart order. */
export interface StreamChartOrderMessage {
  type: 'chartOrder';
  data: ChartOrder;
}

export interface StreamErrorMessage {
  type: 'error';
  error: {
    code: string;
    message: string;
  };
}

export type StreamServerMessage =
  StreamQuoteMessage | StreamOrderUpdateMessage | StreamChartOrderMessage | StreamErrorMessage;
