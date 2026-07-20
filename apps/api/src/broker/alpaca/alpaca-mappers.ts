import {
  Candle,
  OptionContract,
  OptionType,
  OrderResult,
  OrderStatus,
  Position,
  Quote,
} from '@0dtetrader/shared-types';
import { OPTION_MULTIPLIER } from '../contract-resolution';

/**
 * Pure mapping between Alpaca v2 payloads and the shared DTOs. Alpaca
 * returns numbers as JSON numbers (not strings like Webull) and option symbols
 * as canonical OCC (e.g. "SPY250621C00300000"), so the same OCC helpers
 * used by the Webull gateway apply. Field shapes follow the Alpaca v2 API
 * reference and are flagged [best-effort] where the live paper account must
 * confirm them (see docs/ALPACA-INTEGRATION.md). Corrections stay local
 * to this file.
 */

export function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'string' ? Number(value) : (value as number);
  return Number.isFinite(n) ? n : fallback;
}

function isoFrom(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value > 1e12 ? value : value * 1000).toISOString();
  }
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

/** Per-symbol snapshot object from /v2/stocks/snapshots or
 *  /v2/options/snapshots (the value keyed by symbol in the returned map). */
export interface AlpacaSnapshot {
  latestQuote?: {
    bp?: unknown;
    ap?: unknown;
    bps?: unknown;
    aps?: unknown;
    t?: unknown;
  };
  latestTrade?: { p?: unknown; s?: unknown; t?: unknown };
  dailyBar?: { v?: unknown };
  greeks?: { delta?: unknown; gamma?: unknown };
  impliedVolatility?: unknown;
}

export function toQuote(symbol: string, snap: AlpacaSnapshot): Quote {
  const q = snap.latestQuote ?? {};
  return {
    symbol,
    bid: num(q.bp),
    ask: num(q.ap),
    last: num(snap.latestTrade?.p ?? q.bp),
    bidSize: num(q.bps),
    askSize: num(q.aps),
    volume: num(snap.dailyBar?.v ?? snap.latestTrade?.s),
    timestamp: isoFrom(q.t ?? snap.latestTrade?.t),
  };
}

export interface AlpacaBar {
  t?: unknown;
  o?: unknown;
  h?: unknown;
  l?: unknown;
  c?: unknown;
  v?: unknown;
}

export function toCandle(bar: AlpacaBar): Candle {
  return {
    time: isoFrom(bar.t),
    open: num(bar.o),
    high: num(bar.h),
    low: num(bar.l),
    close: num(bar.c),
    volume: num(bar.v),
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AlpacaOption {
  symbol?: string;
  strike?: unknown;
  type?: string;
  expiration_date?: string;
  bid?: unknown;
  ask?: unknown;
  last?: unknown;
}

export function toOptionContract(
  option: AlpacaOption,
  underlying: string,
  expiration: string,
): OptionContract {
  const optionType: OptionType = (option.type ?? 'call').toUpperCase() === 'PUT' ? 'put' : 'call';
  return {
    symbol: option.symbol ?? '',
    underlying: underlying.toUpperCase(),
    expiration,
    strike: num(option.strike),
    optionType,
    bid: num(option.bid),
    ask: num(option.ask),
    last: num(option.last ?? option.bid),
  };
}

// ---------------------------------------------------------------------------
// Orders & positions
// ---------------------------------------------------------------------------

const ORDER_STATUS_MAP: Record<string, OrderStatus> = {
  NEW: 'submitted',
  ACCEPTED: 'submitted',
  PENDING_NEW: 'submitted',
  ACCEPTED_FOR_BIDDING: 'submitted',
  PARTIALLY_FILLED: 'partially_filled',
  FILLED: 'filled',
  DONE_FOR_DAY: 'filled',
  CANCELED: 'cancelled',
  REJECTED: 'rejected',
  EXPIRED: 'cancelled',
};

export function mapOrderStatus(status: string | undefined): OrderStatus {
  return ORDER_STATUS_MAP[(status ?? '').toUpperCase()] ?? 'submitted';
}

export interface AlpacaOrder {
  id?: string;
  client_order_id?: string;
  status?: string;
  symbol?: string;
  side?: string;
  type?: string;
  qty?: unknown;
  filled_qty?: unknown;
  filled_avg_price?: unknown;
  limit_price?: unknown;
  submitted_at?: unknown;
}

export function toOrderResult(order: AlpacaOrder): OrderResult {
  const limitPrice = num(order.limit_price, NaN);
  const filledPrice = num(order.filled_avg_price, NaN);
  const filledQuantity = num(order.filled_qty, NaN);
  const rawType = (order.type ?? '').toUpperCase();
  return {
    orderId: order.client_order_id ?? order.id ?? '',
    status: mapOrderStatus(order.status),
    contractSymbol: order.symbol ?? '',
    side: (order.side ?? '').toUpperCase() === 'SELL' ? 'sell' : 'buy',
    quantity: num(order.qty),
    orderType: rawType === 'MARKET' ? 'market' : 'mid',
    ...(Number.isFinite(limitPrice) && rawType !== 'MARKET' ? { limitPrice } : {}),
    ...(Number.isFinite(filledPrice) ? { filledPrice } : {}),
    ...(Number.isFinite(filledQuantity) ? { filledQuantity } : {}),
    timestamp: isoFrom(order.submitted_at),
  };
}

export interface AlpacaPosition {
  symbol?: string;
  qty?: unknown;
  avg_entry_price?: unknown;
  current_price?: unknown;
  unrealized_pl?: unknown;
  asset_class?: string;
}

/** Maps an Alpaca position row; returns null for asset types the app ignores. */
export function toPosition(pos: AlpacaPosition): Position | null {
  const type = (pos.asset_class ?? '').toUpperCase();
  // Alpaca options carry asset_class "us_option"; equities are ignored.
  if (type !== 'US_OPTION' && type !== 'OPTION') return null;
  return {
    symbol: pos.symbol ?? '',
    assetClass: 'option',
    quantity: num(pos.qty),
    avgPrice: num(pos.avg_entry_price),
    markPrice: num(pos.current_price),
    unrealizedPnl: num(pos.unrealized_pl),
    multiplier: OPTION_MULTIPLIER,
  };
}
