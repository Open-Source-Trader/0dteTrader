import { Injectable, Logger } from '@nestjs/common';
import type { ChainOption } from './gex.types';

interface TradierGreeks {
  delta?: number;
  gamma?: number;
  mid_iv?: number;
}

interface TradierChainOption {
  symbol: string;
  strike: number;
  option_type: 'call' | 'put';
  open_interest?: number;
  bid?: number;
  ask?: number;
  last?: number;
  greeks?: TradierGreeks;
}

type FetchImpl = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

/**
 * Thin Tradier REST client. The chain endpoint returns OI, bid/ask and
 * Greeks in one call, so no batching is needed. OI is static intraday —
 * chain responses are cached per (symbol, expiration, calendar day) and
 * only spot refreshes during the session.
 */
@Injectable()
export class TradierClient {
  private readonly logger = new Logger(TradierClient.name);
  private chainCache = new Map<string, { day: string; options: ChainOption[] }>();
  private rateLimitRemaining: number | null = null;

  constructor(
    private readonly token: string,
    private readonly baseUrl: string,
    private readonly fetchImpl?: FetchImpl,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const fetchFn: FetchImpl =
      this.fetchImpl ??
      ((globalThis.fetch as unknown as FetchImpl).bind(globalThis));
    const response = await fetchFn(`${this.baseUrl}/v1${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining !== null) {
      this.rateLimitRemaining = Number(remaining);
      if (this.rateLimitRemaining < 10) {
        this.logger.warn(`Tradier rate limit nearly exhausted: ${remaining} remaining`);
      }
    }
    if (!response.ok) {
      throw new Error(`Tradier ${path} -> HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }

  /** Available expiration dates (YYYY-MM-DD), ascending. */
  async getExpirations(symbol: string): Promise<string[]> {
    const body = await this.get<{
      expirations?: { date?: string[] | string } | null;
    }>(`/markets/options/expirations?symbol=${encodeURIComponent(symbol)}`);
    const dates = body.expirations?.date;
    if (!dates) return [];
    return (Array.isArray(dates) ? dates : [dates]).sort();
  }

  /** Underlying spot (last trade). */
  async getSpot(symbol: string): Promise<number> {
    const body = await this.get<{
      quotes?: { quote?: { last?: number } | Array<{ last?: number }> };
    }>(`/markets/quotes?symbols=${encodeURIComponent(symbol)}`);
    const quote = body.quotes?.quote;
    const last = Array.isArray(quote) ? quote[0]?.last : quote?.last;
    if (last === undefined || last <= 0) {
      throw new Error(`Tradier returned no usable last price for ${symbol}`);
    }
    return last;
  }

  /**
   * Full chain for one expiration. Cached per calendar day: OI (the bulk of
   * the payload) is static intraday, and bid/ask/IV move slowly enough at
   * the refresh cadence the service drives.
   */
  async getChain(symbol: string, expiration: string): Promise<ChainOption[]> {
    const key = `${symbol}:${expiration}`;
    const day = new Date().toISOString().slice(0, 10);
    const cached = this.chainCache.get(key);
    if (cached && cached.day === day) return cached.options;

    const body = await this.get<{
      chain?: { option?: TradierChainOption[] | TradierChainOption } | null;
    }>(
      `/markets/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${expiration}&greeks=true`,
    );
    const raw = body.chain?.option;
    const list = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
    const options: ChainOption[] = list.map((option) => ({
      symbol: option.symbol,
      strike: option.strike,
      optionType: option.option_type,
      openInterest: option.open_interest ?? 0,
      bid: option.bid ?? null,
      ask: option.ask ?? null,
      last: option.last ?? null,
      midIv: option.greeks?.mid_iv ?? null,
      delta: option.greeks?.delta ?? null,
      gamma: option.greeks?.gamma ?? null,
    }));

    // Fresh fetch today: drop stale entries for other days of the same key.
    this.chainCache.set(key, { day, options });
    return options;
  }
}
