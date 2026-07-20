/**
 * ============================================================================
 * Alpaca v2 API — endpoint & payload map (THE ONLY FILE WITH WIRE DETAILS)
 * ============================================================================
 *
 * ⚠️  VERIFICATION STATUS — shapes below are taken from Alpaca's public v2
 * docs (api-reference) and the v2 trading/market-data references. They MUST be
 * re-verified against the paper account (scripts/alpaca-smoke.ts, analogous to
 * scripts/webull-smoke.ts) before any live trading. Corrections belong here.
 *
 * Sources used:
 *  - Alpaca API Reference: /v2/stocks, /v2/options, /v2/positions,
 *    /v2/orders, /v2/account (trading + market-data hosts).
 *  - The v2 orders endpoint is the single path for all asset classes; options
 *    are ordered by OCC symbol with asset_class: "option".
 *
 * NOTEs / differences from Webull:
 *  - Auth is HTTP Basic (key:secret) — no HMAC signer, no token
 *    lifecycle, no SMS 2FA. Keys are effectively long-lived.
 *  - Orders/positions are SCOPED TO THE API KEY's account — no account_id
 *    parameter is required (unlike Webull).
 *  - A real options-chain endpoint exists (/v2/options/chains) — no
 *    strike-grid probe (the Webull hack is gone).
 *
 * Response payload → DTO translation lives in alpaca-mappers.ts; request
 * building lives here.
 */

import { createHash } from 'node:crypto';
import { CandleInterval, OptionType, OrderRequest } from '@0dtetrader/shared-types';
import { formatOccSymbol } from '../contract-resolution';

// ---------------------------------------------------------------------------
// Hosts [verified: Alpaca API reference — trading vs market-data hosts]
// ---------------------------------------------------------------------------

export interface AlpacaHosts {
  /** Trade/account/order API. */
  trading: string;
  /** Market data API (bars, snapshots, chains). */
  data: string;
}

export const ALPACA_LIVE_HOSTS: AlpacaHosts = {
  trading: 'https://api.alpaca.markets',
  data: 'https://data.alpaca.markets',
};

export const ALPACA_PAPER_HOSTS: AlpacaHosts = {
  trading: 'https://paper-api.alpaca.markets',
  data: 'https://paper-data.alpaca.markets',
};

// ---------------------------------------------------------------------------
// Paths [verified: Alpaca API reference]
// ---------------------------------------------------------------------------

export const EP = {
  account: { host: 'trading', method: 'GET', path: '/v2/account' },

  // Market data (data host)
  stockBars: { host: 'data', method: 'GET', path: '/v2/stocks/{symbol}/bars' },
  stockSnapshots: { host: 'data', method: 'GET', path: '/v2/stocks/snapshots' },
  optionBars: { host: 'data', method: 'GET', path: '/v2/options/{symbol}/bars' },
  optionSnapshots: { host: 'data', method: 'GET', path: '/v2/options/snapshots' },
  optionChain: { host: 'data', method: 'GET', path: '/v2/options/chains' },

  // Trade/account (trading host)
  positions: { host: 'trading', method: 'GET', path: '/v2/positions' },
  orders: { host: 'trading', method: 'POST', path: '/v2/orders' },
  ordersOpen: { host: 'trading', method: 'GET', path: '/v2/orders' },
  orderById: { host: 'trading', method: 'GET', path: '/v2/orders/{id}' },
  orderCancel: { host: 'trading', method: 'DELETE', path: '/v2/orders/{id}' },
  orderCancelClient: { host: 'trading', method: 'DELETE', path: '/v2/orders/client:{clientId}' },
} as const;

export type EndpointKey = keyof typeof EP;

// ---------------------------------------------------------------------------
// Enums / constants
// ---------------------------------------------------------------------------

/** Candle interval → Alpaca `timeframe`. [verified: /v2/.../bars]
 *  Weekly has no native timeframe — aggregated from daily bars (like Webull). */
export const TIMEFRAME: Record<CandleInterval, string> = {
  '1m': '1Min',
  '5m': '5Min',
  '15m': '15Min',
  '30m': '30Min',
  '1h': '1Hour',
  '4h': '4Hour',
  '1d': '1Day',
  '1w': '1Day',
};

/** Option type → Alpaca `type`. */
export function alpacaOptionType(optionType: OptionType): 'call' | 'put' {
  return optionType === 'call' ? 'call' : 'put';
}

// ---------------------------------------------------------------------------
// Symbol helpers
// ---------------------------------------------------------------------------

/** Alpaca OCC option symbol. Our canonical OCC format (contract-resolution
 *  formatOccSymbol) is byte-compatible with Alpaca's — root is 1–6 chars,
 *  no padding is applied, so symbols like SPY/QQQ/IWM/SPX map 1:1. */
export { formatOccSymbol };

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Our idempotency key → Alpaca client_order_id: deterministic MD5 hex.
 * Mirrors Webull exactly (same userId:key mixing) so behaviour is identical
 * across providers. MD5 is used purely as an idempotency id, not for
 * security. Alpaca accepts up to 64 chars; MD5's 32 are well within.
 */
export function alpacaClientOrderId(userId: string, idempotencyKey: string): string {
  return createHash('md5').update(`${userId}:${idempotencyKey}`).digest('hex');
}

export interface ResolvedOptionTerms {
  underlying: string;
  expiration: string; // YYYY-MM-DD
  strike: number;
  optionType: OptionType;
}

export interface AlpacaNewOrder {
  symbol: string;
  qty: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  time_in_force: 'day';
  asset_class: 'option';
  client_order_id: string;
  limit_price?: string;
}

/**
 * Single-leg option order (Alpaca v2 /v2/orders). `mid` maps to a LIMIT
 * order at the recomputed mid; `market` maps to MARKET with no limit price.
 * The OCC symbol is built from resolved terms — parity with Webull mappers.
 */
export function buildOptionOrder(
  order: OrderRequest,
  terms: ResolvedOptionTerms,
  clientOrderId: string,
  limitPrice?: number,
): AlpacaNewOrder {
  return {
    symbol: formatOccSymbol(
      terms.underlying.toUpperCase(),
      terms.expiration,
      terms.optionType,
      terms.strike,
    ),
    qty: String(order.quantity),
    side: order.side,
    type: order.orderType === 'market' ? 'market' : 'limit',
    time_in_force: 'day',
    asset_class: 'option',
    client_order_id: clientOrderId,
    ...(order.orderType === 'market' || limitPrice === undefined
      ? {}
      : { limit_price: String(limitPrice) }),
  };
}

// ---------------------------------------------------------------------------
// Response fragments
// ---------------------------------------------------------------------------

/** Tolerant list unwrap — Alpaca returns bare arrays, or wraps them in a
 *  singular envelope key (bars, options, symbols, data, list, results). */
export function asArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const d = raw as Record<string, unknown>;
    for (const key of ['bars', 'options', 'symbols', 'data', 'list', 'results']) {
      if (Array.isArray(d[key])) return d[key] as unknown[];
    }
  }
  return [];
}

/** Tolerant object unwrap. */
export function asObject(raw: unknown): Record<string, unknown> {
  if (Array.isArray(raw)) return (raw[0] ?? {}) as Record<string, unknown>;
  return (raw ?? {}) as Record<string, unknown>;
}
