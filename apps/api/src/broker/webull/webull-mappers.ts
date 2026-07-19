import {
  Candle,
  CandleInterval,
  OptionContract,
  OrderResult,
  OrderStatus,
  Position,
  Quote,
} from '@0dtetrader/shared-types';
import { formatOccSymbol, OPTION_MULTIPLIER } from '../contract-resolution';

/**
 * Pure mapping between Webull OpenAPI payloads and the shared DTOs. Field
 * shapes were taken from the OpenAPI docs and are confirmed against sandbox
 * (scripts/webull-smoke.ts) — corrections stay local to this file.
 * Webull returns most numbers as strings; num() tolerates both.
 */

export function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'string' ? Number(value) : (value as number);
  return Number.isFinite(n) ? n : fallback;
}

function isoFrom(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value > 1e12 ? value : value * 1000).toISOString();
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

export interface WebullSnapshot {
  symbol?: string;
  bid?: unknown;
  ask?: unknown;
  price?: unknown;
  last?: unknown;
  bid_size?: unknown;
  ask_size?: unknown;
  volume?: unknown;
  last_trade_time?: unknown;
  timestamp?: unknown;
}

export function toQuote(symbol: string, snap: WebullSnapshot): Quote {
  return {
    symbol,
    bid: num(snap.bid),
    ask: num(snap.ask),
    last: num(snap.price ?? snap.last),
    bidSize: num(snap.bid_size),
    askSize: num(snap.ask_size),
    volume: num(snap.volume),
    timestamp: isoFrom(snap.last_trade_time ?? snap.timestamp),
  };
}

export interface WebullBar {
  time?: unknown;
  timestamp?: unknown;
  open?: unknown;
  high?: unknown;
  low?: unknown;
  close?: unknown;
  volume?: unknown;
}

export function toCandle(bar: WebullBar): Candle {
  return {
    time: isoFrom(bar.time ?? bar.timestamp),
    open: num(bar.open),
    high: num(bar.high),
    low: num(bar.low),
    close: num(bar.close),
    volume: num(bar.volume),
  };
}

export const INTERVAL_TO_TIMESPAN: Record<CandleInterval, string> = {
  '1m': 'M1',
  '5m': 'M5',
  '15m': 'M15',
  '30m': 'M30',
  '1h': 'M60',
  '4h': 'M240',
  '1d': 'D',
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export function toOptionContract(
  occSymbol: string,
  underlying: string,
  expiration: string,
  strike: number,
  optionType: 'call' | 'put',
  snap: WebullSnapshot,
): OptionContract {
  return {
    symbol: occSymbol,
    underlying: underlying.toUpperCase(),
    expiration,
    strike,
    optionType,
    bid: num(snap.bid),
    ask: num(snap.ask),
    last: num(snap.price ?? snap.last),
  };
}

// ---------------------------------------------------------------------------
// Orders & positions
// ---------------------------------------------------------------------------

const ORDER_STATUS_MAP: Record<string, OrderStatus> = {
  PENDING: 'submitted',
  SUBMITTED: 'submitted',
  PARTIAL_FILLED: 'partially_filled',
  PARTIALLY_FILLED: 'partially_filled',
  FILLED: 'filled',
  CANCELLED: 'cancelled',
  CANCELED: 'cancelled',
  FAILED: 'rejected',
  REJECTED: 'rejected',
};

export function mapOrderStatus(status: string | undefined): OrderStatus {
  return ORDER_STATUS_MAP[(status ?? '').toUpperCase()] ?? 'submitted';
}

export interface WebullOrderLeg {
  symbol?: string;
  strike_price?: unknown;
  option_expire_date?: string;
  option_type?: string;
}

export interface WebullOrder {
  client_order_id?: string;
  order_id?: string;
  status?: string;
  order_status?: string;
  symbol?: string;
  instrument_type?: string;
  side?: string;
  order_type?: string;
  limit_price?: unknown;
  filled_price?: unknown;
  avg_filled_price?: unknown;
  quantity?: unknown;
  /** Filled-quantity field name variants [best-effort — verify live]. */
  filled_quantity?: unknown;
  cum_quantity?: unknown;
  filled_qty?: unknown;
  place_time_at?: unknown;
  contract_month?: string;
  legs?: WebullOrderLeg[];
}

/** Resolves the app-facing contract symbol for a Webull order/position row. */
export function contractSymbolOf(order: {
  symbol?: string;
  instrument_type?: string;
  contract_month?: string;
  legs?: WebullOrderLeg[];
}): string {
  const leg = order.legs?.[0];
  if (order.instrument_type === 'OPTION' && leg?.option_expire_date) {
    return formatOccSymbol(
      leg.symbol ?? order.symbol ?? '',
      leg.option_expire_date,
      (leg.option_type ?? '').toUpperCase() === 'PUT' ? 'put' : 'call',
      num(leg.strike_price),
    );
  }
  return order.symbol ?? '';
}

export function toOrderResult(order: WebullOrder): OrderResult {
  const limitPrice = num(order.limit_price, NaN);
  const filledPrice = num(order.filled_price ?? order.avg_filled_price, NaN);
  const filledQuantity = num(order.filled_quantity ?? order.cum_quantity ?? order.filled_qty, NaN);
  return {
    orderId: order.client_order_id ?? order.order_id ?? '',
    status: mapOrderStatus(order.status ?? order.order_status),
    contractSymbol: contractSymbolOf(order),
    side: (order.side ?? '').toUpperCase() === 'SELL' ? 'sell' : 'buy',
    quantity: num(order.quantity),
    // The app only submits market and mid (rested as LIMIT) orders.
    orderType: (order.order_type ?? '').toUpperCase() === 'MARKET' ? 'market' : 'mid',
    ...(Number.isFinite(limitPrice) ? { limitPrice } : {}),
    ...(Number.isFinite(filledPrice) ? { filledPrice } : {}),
    ...(Number.isFinite(filledQuantity) ? { filledQuantity } : {}),
    timestamp: isoFrom(order.place_time_at),
  };
}

export interface WebullPosition {
  symbol?: string;
  instrument_type?: string;
  quantity?: unknown;
  cost_price?: unknown;
  last_price?: unknown;
  unrealized_profit_loss?: unknown;
  contract_month?: string;
  legs?: WebullOrderLeg[];
}

/** Maps a Webull position row; returns null for asset types the app ignores. */
export function toPosition(pos: WebullPosition): Position | null {
  const type = (pos.instrument_type ?? '').toUpperCase();
  if (type !== 'OPTION') return null;
  return {
    symbol: contractSymbolOf(pos),
    assetClass: 'option',
    quantity: num(pos.quantity),
    avgPrice: num(pos.cost_price),
    markPrice: num(pos.last_price),
    unrealizedPnl: num(pos.unrealized_profit_loss),
    multiplier: OPTION_MULTIPLIER,
  };
}
