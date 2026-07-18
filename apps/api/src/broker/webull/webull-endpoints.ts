/**
 * ============================================================================
 * Webull OpenAPI — endpoint & payload map (THE ONLY FILE WITH WIRE DETAILS)
 * ============================================================================
 *
 * ⚠️  VERIFICATION STATUS — every mapping below was extracted from public
 * sources on 2026-07-17 and MUST be re-verified against the live docs before
 * real trading (docs/WEBULL-INTEGRATION.md §1; scripts/webull-smoke.ts is the
 * verification vehicle). Corrections belong in this file only. Per-entry
 * confidence is marked [verified] (seen in official SDK source code or
 * official docs) vs [best-effort] (inferred / not published).
 *
 * Sources used:
 *  - Official Python SDK source (webull-inc/webull-openapi-python-sdk @10889b5,
 *    2026-07-06): paths, params, signing, token flow, order payloads.
 *  - Official MCP server source (webull-inc/webull-mcp-server, 2026-04):
 *    response field names (positions, balance, snapshot, orders, instruments).
 *  - developer.webull.com/apis/docs: changelog (2025-11-20 → 2026-07-13),
 *    trade-api guides, reference pages (paths + rate limits; response schemas
 *    are JS-rendered and could not be extracted).
 *  - dev.to/zuplo Webull API guide (2025-05): protocol/architecture overview.
 *
 * Response payload → DTO translation lives in webull-mappers.ts; request
 * signing lives in webull-signer.ts. This file keeps paths, query params,
 * and order payload construction.
 *
 * NOT FOUND in the official API (genuine gaps, see changelog API surface):
 *  - No option-chain / expiration-list endpoint. Options are ORDERED BY TERMS
 *    (underlying + strike + expiry + call/put) and QUOTED BY OCC SYMBOL via
 *    option snapshot. getOptionsChain() therefore probes candidate OCC
 *    symbols — see webull-broker.gateway.ts [best-effort].
 *  - No published per-endpoint rate limits except where noted below.
 */

import { createHash } from 'node:crypto';
import { CandleInterval, OptionType, OrderRequest } from '@0dtetrader/shared-types';
import { formatOccSymbol, OPTION_MULTIPLIER } from '../contract-resolution';

// ---------------------------------------------------------------------------
// Hosts [verified: SDK webull/core/data/endpoints.json, changelog 2026-07-08]
// ---------------------------------------------------------------------------

export interface WebullHosts {
  /** Trade/auth/account API — e.g. https://api.webull.com */
  api: string;
  /** Market data API — e.g. https://data-api.webull.com */
  data: string;
}

export const WEBULL_PROD_HOSTS: WebullHosts = {
  api: 'https://api.webull.com',
  data: 'https://data-api.webull.com',
};

export const WEBULL_SANDBOX_HOSTS: WebullHosts = {
  api: 'https://api.sandbox.webull.com',
  data: 'https://data-api.sandbox.webull.com',
};

// ---------------------------------------------------------------------------
// Paths [verified: SDK request classes]. All are version "v2" (x-version).
// ---------------------------------------------------------------------------

export const WEBULL_API_VERSION = 'v2';

export const EP = {
  // Auth — api host. token/create rate limit: 10 req / 30 s [verified: docs].
  tokenCreate: { host: 'api', method: 'POST', path: '/openapi/auth/token/create' },
  tokenRefresh: { host: 'api', method: 'POST', path: '/openapi/auth/token/refresh' },
  tokenCheck: { host: 'api', method: 'POST', path: '/openapi/auth/token/check' },

  // Market data — data host, GET. bars rate limit: 60 req/min [verified: docs].
  stockSnapshot: { host: 'data', method: 'GET', path: '/openapi/market-data/stock/snapshot' },
  stockBars: { host: 'data', method: 'GET', path: '/openapi/market-data/stock/bars' },
  optionSnapshot: { host: 'data', method: 'GET', path: '/openapi/market-data/option/snapshot' },
  optionBars: { host: 'data', method: 'GET', path: '/openapi/market-data/option/bars' },

  // Account — api host, GET. positions rate limit: 2 req / 2 s [verified: docs].
  accountList: { host: 'api', method: 'GET', path: '/openapi/account/list' },
  balance: { host: 'api', method: 'GET', path: '/openapi/assets/balance' },
  positions: { host: 'api', method: 'GET', path: '/openapi/assets/positions' },

  // Unified orders — api host, POST. Since 2025-12-13 a single order place
  // API handles all instrument types [verified: changelog; options trade-api
  // doc examples; scripts/webull-smoke.ts exercises these for options].
  orderPreview: { host: 'api', method: 'POST', path: '/openapi/trade/order/preview' },
  orderPlace: { host: 'api', method: 'POST', path: '/openapi/trade/order/place' },
  orderReplace: { host: 'api', method: 'POST', path: '/openapi/trade/order/replace' },
  orderCancel: { host: 'api', method: 'POST', path: '/openapi/trade/order/cancel' },
  orderOpen: { host: 'api', method: 'GET', path: '/openapi/trade/order/open' },
  orderDetail: { host: 'api', method: 'GET', path: '/openapi/trade/order/detail' },

  // Asset-specific alternatives [verified: SDK v2 request classes]. Not used
  // by the gateway (it prefers the unified endpoints) but kept here because
  // they are the documented fallback if unified misbehaves for options.
  optionPreview: { host: 'api', method: 'POST', path: '/openapi/trade/option/order/preview' },
  optionPlace: { host: 'api', method: 'POST', path: '/openapi/trade/option/order/place' },
  optionReplace: { host: 'api', method: 'POST', path: '/openapi/trade/option/order/replace' },
  optionCancel: { host: 'api', method: 'POST', path: '/openapi/trade/option/order/cancel' },
} as const;

export type EndpointKey = keyof typeof EP;

// ---------------------------------------------------------------------------
// Enums / constants
// ---------------------------------------------------------------------------

/** Instrument categories (query param `category`). [verified: SDK Category] */
export const CATEGORY = {
  stock: 'US_STOCK',
  option: 'US_OPTION',
} as const;

/** Candle interval → Webull `timespan`. [verified: SDK Timespan] */
export const TIMESPAN: Record<CandleInterval, string> = {
  '1m': 'M1',
  '5m': 'M5',
  '15m': 'M15',
  '1h': 'M60',
  '1d': 'D',
};

// ---------------------------------------------------------------------------
// Symbol helpers
// ---------------------------------------------------------------------------

/** Webull OCC option symbol — identical to our canonical OCC format.
 *  [verified: SDK option snapshot docstring: "AAPL260522C00300000"] */
export { formatOccSymbol };

// ---------------------------------------------------------------------------
// Order payloads [verified: SDK samples/order/*.py + trade-api doc examples]
// ---------------------------------------------------------------------------

export type PositionIntent =
  | 'BUY_TO_OPEN'
  | 'BUY_TO_CLOSE'
  | 'SELL_TO_OPEN'
  | 'SELL_TO_CLOSE';

/**
 * Picks the position_intent for an option order from the current position
 * [verified: field added 2026-03-28, changelog]. Buy against a short position
 * closes it; sell against a long position closes it; otherwise it opens.
 */
export function positionIntentFor(
  side: 'buy' | 'sell',
  existingQuantity: number,
): PositionIntent {
  if (side === 'buy') {
    return existingQuantity < 0 ? 'BUY_TO_CLOSE' : 'BUY_TO_OPEN';
  }
  return existingQuantity > 0 ? 'SELL_TO_CLOSE' : 'SELL_TO_OPEN';
}

export interface WebullOrderLeg {
  side: 'BUY' | 'SELL';
  quantity: string;
  symbol: string;
  strike_price?: string;
  option_expire_date?: string;
  instrument_type: 'OPTION' | 'EQUITY';
  option_type?: 'CALL' | 'PUT';
  market: 'US';
}

export interface WebullNewOrder {
  client_order_id: string;
  combo_type: 'NORMAL';
  order_type: 'LIMIT' | 'MARKET';
  quantity: string;
  limit_price?: string;
  side: 'BUY' | 'SELL';
  time_in_force: 'DAY' | 'GTC';
  entrust_type: 'QTY';
  instrument_type: 'OPTION' | 'EQUITY';
  market: 'US';
  symbol: string;
  option_strategy?: 'SINGLE';
  position_intent?: PositionIntent;
  legs?: WebullNewOrderLeg[];
}

export type WebullNewOrderLeg = WebullOrderLeg;

// (WebullNewOrderLeg kept as a readable alias for payload consumers.)

/**
 * Our idempotency key → Webull client_order_id: deterministic MD5 hex
 * (32 chars — exactly Webull's limit, always unique per key). MD5 is used
 * purely as an idempotency id, not for security.
 */
export function toClientOrderId(idempotencyKey: string): string {
  return createHash('md5').update(idempotencyKey).digest('hex');
}

export interface ResolvedOptionTerms {
  underlying: string;
  expiration: string; // YYYY-MM-DD
  strike: number;
  optionType: OptionType;
}

/**
 * Single-leg option order for the unified endpoint (docs: trade-api/options;
 * SDK order_option_client.py; scripts/webull-smoke.ts). `mid` maps to a LIMIT
 * order at the recomputed mid; `market` maps to MARKET with no limit price.
 */
export function buildOptionOrder(
  order: OrderRequest,
  terms: ResolvedOptionTerms,
  clientOrderId: string,
  limitPrice?: number,
  positionIntent?: PositionIntent,
): WebullNewOrder {
  const side = order.side.toUpperCase() as 'BUY' | 'SELL';
  const newOrder: WebullNewOrder = {
    client_order_id: clientOrderId,
    combo_type: 'NORMAL',
    order_type: order.orderType === 'market' ? 'MARKET' : 'LIMIT',
    quantity: String(order.quantity),
    side,
    time_in_force: 'DAY',
    entrust_type: 'QTY',
    instrument_type: 'OPTION',
    market: 'US',
    symbol: terms.underlying.toUpperCase(),
    option_strategy: 'SINGLE',
    legs: [
      {
        side,
        quantity: String(order.quantity),
        symbol: terms.underlying.toUpperCase(),
        strike_price: String(terms.strike),
        option_expire_date: terms.expiration,
        instrument_type: 'OPTION',
        option_type: terms.optionType.toUpperCase() as 'CALL' | 'PUT',
        market: 'US',
      },
    ],
  };
  if (positionIntent) newOrder.position_intent = positionIntent;
  if (newOrder.order_type === 'LIMIT' && limitPrice !== undefined) {
    newOrder.limit_price = String(limitPrice);
  }
  return newOrder;
}

// ---------------------------------------------------------------------------
// Response fragments that are NOT DTO-mapped in webull-mappers.ts
// ---------------------------------------------------------------------------

const asNum = (v: unknown): number | undefined => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Buying power from the balance response.
 *  [verified fields: account_currency_assets[].buying_power /
 *   option_buying_power / day_buying_power] */
export function parseBuyingPower(raw: unknown): number | undefined {
  const data = (raw ?? {}) as Record<string, unknown>;
  const assets = Array.isArray(data.account_currency_assets)
    ? (data.account_currency_assets as Record<string, unknown>[])
    : [];
  const usd =
    assets.find((a) => String(a.currency ?? 'USD') === 'USD') ?? assets[0];
  if (!usd) return undefined;
  return asNum(usd.option_buying_power) ?? asNum(usd.buying_power);
}

/** Place/preview order response → { clientOrderId, orderId }.
 *  [verified: MCP _format_order_result] */
export function parsePlaceResult(raw: unknown): {
  clientOrderId?: string;
  orderId?: string;
} {
  const d = (raw ?? {}) as Record<string, unknown>;
  const inner = Array.isArray(d.orders)
    ? (d.orders[0] as Record<string, unknown>)
    : Array.isArray(raw)
      ? (raw[0] as Record<string, unknown>)
      : d;
  return {
    clientOrderId:
      inner?.client_order_id !== undefined
        ? String(inner.client_order_id)
        : undefined,
    orderId: inner?.order_id !== undefined ? String(inner.order_id) : undefined,
  };
}

/** Preview response → estimated cost / buying-power effect. Field names are
 *  not published; docs mention estimated_cost / estimated_transaction_fee
 *  [best-effort — undefined → callers estimate locally]. */
export function parsePreviewCost(raw: unknown): number | undefined {
  const d = (raw ?? {}) as Record<string, unknown>;
  return (
    asNum(d.estimated_cost) ??
    asNum(d.est_cost) ??
    asNum(d.estimated_buying_power) ??
    asNum(d.estimated_cash) ??
    asNum(d.amount)
  );
}

/**
 * Error body variants seen across docs and sandbox:
 * { code | error_code, message | msg } [verified: SDK client.py + smoke].
 */
export function parseErrorBody(raw: unknown): { code?: string; message?: string } {
  const d = (raw ?? {}) as Record<string, unknown>;
  const code = d.code ?? d.error_code;
  const message = d.message ?? d.msg;
  return {
    code: code !== undefined ? String(code) : undefined,
    message: message !== undefined ? String(message) : undefined,
  };
}

/** Tolerant list unwrap — Webull returns bare arrays or {result|data|list}. */
export function asArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const d = raw as Record<string, unknown>;
    for (const key of ['result', 'data', 'list']) {
      if (Array.isArray(d[key])) return d[key] as unknown[];
    }
  }
  return [];
}

/** Tolerant object unwrap — detail responses are objects or 1-element lists. */
export function asObject(raw: unknown): Record<string, unknown> {
  if (Array.isArray(raw)) return (raw[0] ?? {}) as Record<string, unknown>;
  return (raw ?? {}) as Record<string, unknown>;
}

export { OPTION_MULTIPLIER };
