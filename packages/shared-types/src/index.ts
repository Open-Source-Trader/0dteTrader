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
/** Broker a user trades through. Webull is the only active provider in P1;
 *  Alpaca is added behind the same BrokerGateway seam. */
export type BrokerProvider = 'webull' | 'alpaca';
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'mid' | 'market';
export type OptionType = 'call' | 'put';
export type SelectionMode = 'auto_otm' | 'explicit';
export type OrderStatus = 'submitted' | 'filled' | 'partially_filled' | 'cancelled' | 'rejected';
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
export type BrokerSecrets = WebullSecrets | AlpacaSecrets;

/** Provider-scoped credential input from the client. */
export interface AlpacaCredentialsInput {
  provider: 'alpaca';
  apiKey: string;
  apiSecret: string;
  environment?: TradingMode;
}
export type BrokerCredentialsInput = WebullCredentialsInput | AlpacaCredentialsInput;

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
  provider: BrokerProvider;
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
  /** YYYY-MM-DD list, ascending (nearest first). */
  expirations: string[];
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
  selection: OrderSelection;
}

export interface OrderPreview {
  resolved: {
    contractSymbol: string;
    price: number;
    estBuyingPower: number;
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

export interface StreamErrorMessage {
  type: 'error';
  error: {
    code: string;
    message: string;
  };
}

export type StreamServerMessage =
  StreamQuoteMessage | StreamOrderUpdateMessage | StreamErrorMessage;
