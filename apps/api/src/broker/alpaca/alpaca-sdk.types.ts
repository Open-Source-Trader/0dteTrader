import { TradingMode } from '@0dtetrader/shared-types';

/**
 * Minimal structural views of the Alpaca SDK response/request shapes we use.
 *
 * The SDK does not re-export every response type from its package root, and
 * we only read a handful of fields, so we describe just those instead of
 * importing SDK types. This keeps the gateway decoupled from the SDK's exact
 * exported type names and makes the test fake trivial to construct.
 */

export interface SdkQuote {
  bp?: number | string;
  ap?: number | string;
  bps?: number | string;
  aps?: number | string;
  t?: string | number | Date;
}

export interface SdkTrade {
  p?: number | string;
  s?: number | string;
  t?: string | number | Date;
}

export interface SdkOptionSnapshot {
  latestQuote?: SdkQuote;
  latestTrade?: SdkTrade;
  greeks?: { delta?: number; gamma?: number; theta?: number; vega?: number; rho?: number };
  impliedVolatility?: number;
}

export interface SdkStockSnapshot {
  latestQuote?: SdkQuote;
  latestTrade?: SdkTrade;
  dailyBar?: { v?: number | string };
}

export interface SdkBar {
  timestamp: string | number | Date;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
  volume: number | string;
}

export interface SdkOrder {
  id?: string;
  client_order_id?: string;
  status?: string;
  symbol?: string;
  side?: string;
  type?: string;
  qty?: string | number;
  filled_qty?: string | number;
  filled_avg_price?: string | number | null;
  limit_price?: string | number | null;
  submitted_at?: string | number | Date;
}

export interface SdkPosition {
  symbol?: string;
  qty?: string | number;
  avg_entry_price?: string | number;
  current_price?: string | number;
  unrealized_pl?: string | number;
  asset_class?: string;
}

export interface SdkOrderInput {
  type: 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing_stop';
  symbol?: string;
  qty?: number | string;
  side?: 'buy' | 'sell';
  assetClass?: string;
  timeInForce?: string;
  clientOrderId?: string;
  limitPrice?: number | string;
}

export interface SdkBarsRequest {
  timeframe: string;
  start?: Date;
  end?: Date;
  limit: number;
}

interface AlpacaStocksMarketData {
  stockSnapshots(req: { symbols: string[] }): Promise<Record<string, SdkStockSnapshot>>;
}

/** The subset of the SDK's `MarketDataClient` this gateway uses. */
export interface AlpacaMarketData {
  collectOptionSnapshotsBySymbol(req: {
    symbols: string[];
  }): Promise<Record<string, SdkOptionSnapshot>>;
  stocks?: AlpacaStocksMarketData;
  stockSnapshots?(req: { symbols: string[] }): Promise<Record<string, SdkStockSnapshot>>;
  getOptionBarsFor(symbol: string, req: SdkBarsRequest): Promise<SdkBar[]>;
  getStockBarsFor(symbol: string, req: SdkBarsRequest): Promise<SdkBar[]>;
  collectOptionChainBySymbol(req: {
    underlyingSymbol: string;
    expirationDate?: Date;
  }): Promise<Record<string, SdkOptionSnapshot>>;
}

/** The subset of the SDK's `TradingClient` this gateway uses. */
export interface AlpacaTrading {
  orders: {
    submit(input: SdkOrderInput): Promise<SdkOrder>;
    getAllOrders(params: { status?: string; limit?: number }): Promise<SdkOrder[]>;
    getOrderByClientOrderId(params: { clientOrderId: string }): Promise<SdkOrder>;
    deleteOrderByOrderID(params: { orderId: string }): Promise<void>;
  };
  positions: { getAllOpenPositions(): Promise<SdkPosition[]> };
}

export interface AlpacaClientLike {
  marketData: AlpacaMarketData;
  trading: AlpacaTrading;
}

export interface AlpacaSecrets {
  apiKey: string;
  apiSecret: string;
}

/**
 * Builds a per-user, per-mode Alpaca client. In production this constructs the
 * real SDK `Alpaca` client; in tests it returns a fake. The real client is
 * structurally compatible with `AlpacaClientLike` (cast at the call site).
 */
export type AlpacaFactory = (secrets: AlpacaSecrets, mode: TradingMode) => AlpacaClientLike;
