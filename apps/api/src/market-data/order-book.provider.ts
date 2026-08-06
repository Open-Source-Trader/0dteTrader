import {
  FreshOrderBookSnapshot,
  OrderBookCapability,
  OrderBookProvider as OrderBookProviderName,
  OrderBookStatus,
  OrderBookUnavailableReason,
} from '@0dtetrader/shared-types';
import { WebullClient } from '../broker/webull/webull-client';
import { validateOrderBook } from './order-book-indicators';

const PROVIDER: OrderBookProviderName = 'webull';
const CAPABILITY: OrderBookCapability = 'nasdaq_totalview_non_display';
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,11}$/;
const UNSUPPORTED = new Set(['SPX', 'NDX', 'RUT', 'VIX']);
const FRESHNESS_LIMIT_MS = 5_000;
const FUTURE_SKEW_LIMIT_MS = 1_000;

export interface OrderBookAvailableResult {
  availability: 'available';
  snapshot: FreshOrderBookSnapshot;
  decoderTimeMs?: number;
}

export interface OrderBookUnavailableResult {
  availability: 'unavailable';
  status: OrderBookStatus & { availability: 'unavailable' };
  decoderTimeMs?: number;
}

export type OrderBookProviderResult = OrderBookAvailableResult | OrderBookUnavailableResult;

export interface OrderBookProvider {
  readonly appKey: string;
  preflight?(symbol: string): OrderBookUnavailableResult | null;
  fetch(symbol: string, depth: number, signal?: AbortSignal): Promise<OrderBookProviderResult>;
}

export interface WebullOrderBookTransport {
  requestDepth(symbol: string, depth: number, signal?: AbortSignal): Promise<unknown>;
}

export interface WebullOrderBookProviderOptions {
  enabled: boolean;
  capabilityProven: boolean;
  maxDepth: number;
  appKey?: string;
  now?: () => Date;
  monotonicNow?: () => number;
}

export class WebullOrderBookProvider implements OrderBookProvider {
  readonly appKey: string;
  private readonly now: () => Date;
  private readonly maxDepth: number;
  private readonly monotonicNow: () => number;

  constructor(
    private readonly transport: WebullOrderBookTransport,
    private readonly options: WebullOrderBookProviderOptions,
  ) {
    this.appKey = options.appKey ?? 'webull-l2-unconfigured';
    this.now = options.now ?? (() => new Date());
    this.maxDepth = Math.max(1, Math.min(50, Math.trunc(options.maxDepth)));
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  async fetch(
    symbolInput: string,
    requestedDepth: number,
    signal?: AbortSignal,
  ): Promise<OrderBookProviderResult> {
    const symbol = symbolInput.trim().toUpperCase();
    const preflight = this.preflight(symbol);
    if (preflight) return preflight;
    const depth = Math.max(1, Math.min(this.maxDepth, Math.trunc(requestedDepth) || 1));
    try {
      const raw = signal
        ? await this.transport.requestDepth(symbol, depth, signal)
        : await this.transport.requestDepth(symbol, depth);
      const receivedAt = this.now();
      const decodeStartedAt = this.monotonicNow();
      const snapshot = decodeWebullOrderBook(raw, symbol, depth, receivedAt.toISOString());
      const decoderTimeMs = Math.max(0, this.monotonicNow() - decodeStartedAt);
      if (!snapshot || !validateOrderBook(snapshot)) {
        return { ...this.unavailable(symbol, 'invalid_book', true), decoderTimeMs };
      }
      const ageMs = receivedAt.getTime() - Date.parse(snapshot.timestamp);
      if (ageMs >= FRESHNESS_LIMIT_MS) return this.unavailable(symbol, 'stale', true);
      if (ageMs < -FUTURE_SKEW_LIMIT_MS) return this.unavailable(symbol, 'invalid_book', true);
      return { availability: 'available', snapshot, decoderTimeMs };
    } catch (error) {
      const status = errorStatus(error);
      if (status === 403) return this.unavailable(symbol, 'entitlement_missing', false);
      if (status === 401) return this.unavailable(symbol, 'invalid_credentials', false);
      if (isTimeout(error)) return this.unavailable(symbol, 'request_timeout', true);
      return this.unavailable(symbol, 'provider_error', true);
    }
  }

  preflight(symbolInput: string): OrderBookUnavailableResult | null {
    const symbol = symbolInput.trim().toUpperCase();
    if (!this.options.enabled) return this.unavailable(symbol, 'provider_unconfigured', false);
    if (!this.options.capabilityProven)
      return this.unavailable(symbol, 'entitlement_missing', false);
    if (!SYMBOL_PATTERN.test(symbol) || UNSUPPORTED.has(symbol)) {
      return this.unavailable(symbol, 'unsupported_instrument', false);
    }
    return null;
  }

  private unavailable(
    symbol: string,
    reason: OrderBookUnavailableReason,
    retryable: boolean,
  ): OrderBookUnavailableResult {
    return {
      availability: 'unavailable',
      status: {
        availability: 'unavailable',
        symbol,
        provider: PROVIDER,
        capability: CAPABILITY,
        freshness: reason === 'stale' ? 'stale' : null,
        reason,
        message: statusMessage(reason),
        retryable,
      },
    };
  }
}

export class WebullClientOrderBookTransport implements WebullOrderBookTransport {
  constructor(private readonly client: WebullClient) {}

  requestDepth(symbol: string, depth: number, signal?: AbortSignal): Promise<unknown> {
    return this.client.request('stockDepth', {
      query: {
        symbol,
        category: 'US_STOCK',
        depth: String(depth),
        overnight_required: 'false',
      },
      automaticRetries: false,
      signal,
    });
  }
}

export function decodeWebullOrderBook(
  value: unknown,
  symbol: string,
  requestedDepth: number,
  receivedAt: string,
): FreshOrderBookSnapshot | null {
  const root = unwrapObject(value);
  if (!root) return null;
  const responseSymbol = root.symbol ?? root.ticker ?? root.instrument_symbol;
  if (
    typeof responseSymbol === 'string' &&
    responseSymbol.trim().toUpperCase() !== symbol.trim().toUpperCase()
  ) {
    return null;
  }
  const bids = decodeLevels(root.bids ?? root.bid_list ?? root.bidList, 'bid');
  const asks = decodeLevels(root.asks ?? root.ask_list ?? root.askList, 'ask');
  const timestamp = decodeTimestamp(
    root.timestamp ?? root.quote_time ?? root.quoteTime ?? root.last_trade_time,
  );
  const depth = Math.min(requestedDepth, bids.length, asks.length);
  if (!timestamp || depth < 1) return null;
  return {
    symbol,
    provider: PROVIDER,
    capability: CAPABILITY,
    freshness: 'fresh',
    timestamp,
    receivedAt,
    depth,
    bids: bids.slice(0, depth),
    asks: asks.slice(0, depth),
  };
}

function unwrapObject(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return unwrapObject(value[0]);
  if (!value || typeof value !== 'object') return null;
  const root = value as Record<string, unknown>;
  const nested = root.data ?? root.result;
  if (nested && nested !== value) return unwrapObject(nested) ?? root;
  return root;
}

function decodeLevels(value: unknown, side: 'bid' | 'ask'): Array<{ price: number; size: number }> {
  if (!Array.isArray(value)) return [];
  const sizesByPrice = new Map<number, number>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const price = Number(raw.price ?? raw.px);
    const size = Number(raw.quantity ?? raw.size ?? raw.qty ?? raw.volume);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size < 0) return [];
    sizesByPrice.set(price, (sizesByPrice.get(price) ?? 0) + size);
  }
  return [...sizesByPrice]
    .map(([price, size]) => ({ price, size }))
    .sort((left, right) => (side === 'bid' ? right.price - left.price : left.price - right.price));
}

function decodeTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(Math.abs(value) < 100_000_000_000 ? value * 1_000 : value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    const epoch = Math.abs(numeric) < 100_000_000_000 ? numeric * 1_000 : numeric;
    const date =
      Number.isFinite(numeric) && value.trim() !== '' ? new Date(epoch) : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return null;
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { status?: unknown; httpStatus?: unknown };
  const status = candidate.status ?? candidate.httpStatus;
  return typeof status === 'number' ? status : undefined;
}

function isTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ETIMEDOUT' || code === 'ABORT_ERR' || code === 'BROKER_REQUEST_TIMEOUT';
}

function statusMessage(reason: OrderBookUnavailableReason): string {
  switch (reason) {
    case 'provider_unconfigured':
      return 'Webull Level 2 is not configured.';
    case 'entitlement_missing':
      return 'Webull Level 2 entitlement is unavailable.';
    case 'unsupported_instrument':
      return 'Level 2 is not supported for this instrument.';
    case 'invalid_credentials':
      return 'Webull Level 2 credentials are invalid.';
    case 'request_timeout':
      return 'Webull Level 2 request timed out.';
    case 'invalid_book':
      return 'Webull returned an invalid order book.';
    default:
      return 'Level 2 data is unavailable.';
  }
}
