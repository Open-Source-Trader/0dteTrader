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
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'mid' | 'market';
export type OptionType = 'call' | 'put';
export type SelectionMode = 'auto_otm' | 'explicit';
export type OrderStatus =
  | 'submitted'
  | 'filled'
  | 'partially_filled'
  | 'cancelled'
  | 'rejected';
export type CandleInterval = '1m' | '5m' | '15m' | '1h' | '1d';

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
  /** Live Webull credentials are stored. */
  webullConfigured: boolean;
  /** Practice (paper) Webull credentials are stored. */
  webullPracticeConfigured: boolean;
}

export interface WebullCredentialsInput {
  appKey: string;
  appSecret: string;
  accountId: string;
  /** Environment this credential set belongs to; defaults to 'live'. */
  environment?: TradingMode;
}

export interface WebullCredentialsSaved {
  webullConfigured: true;
  environment: TradingMode;
}

export interface WebullSessionRefreshed {
  refreshed: true;
  /** Trading mode the fresh token was minted for (the user's current mode). */
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
  | StreamQuoteMessage
  | StreamOrderUpdateMessage
  | StreamErrorMessage;
