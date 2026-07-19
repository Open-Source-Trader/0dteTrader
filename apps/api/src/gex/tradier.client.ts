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
 * Greeks in one call, so no batching is needed.
 *
 * OI handling per spec: the OCC publishes open interest once per day, so
 * the FIRST chain fetch of the day establishes the OI baseline; later
 * fetches refresh prices/Greeks only and the baseline OI is overlaid back
 * onto each contract (a contract absent from the baseline keeps its fresh
 * OI, e.g. a series that listed intraday).
 */
@Injectable()
export class TradierClient {
  private readonly logger = new Logger(TradierClient.name);
  /** OCC symbol -> OI baseline, keyed additionally by calendar day. */
  private oiBaseline = new Map<string, { day: string; oi: Map<string, number> }>();
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
   * Full chain for one expiration. Fetched fresh every call so Greeks and
   * bid/ask track the market; OI is pinned to the day's baseline.
   */
  async getChain(symbol: string, expiration: string): Promise<ChainOption[]> {
    const body = await this.get<{
      chain?: { option?: TradierChainOption[] | TradierChainOption } | null;
    }>(
      `/markets/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${expiration}&greeks=true`,
    );
    const raw = body.chain?.option;
    const list = raw ? (Array.isArray(raw) ? raw : [raw]) : [];

    const key = `${symbol}:${expiration}`;
    const day = new Date().toISOString().slice(0, 10);
    let baseline = this.oiBaseline.get(key);
    if (!baseline || baseline.day !== day) {
      // First fetch of the day: this IS the baseline.
      baseline = {
        day,
        oi: new Map(list.map((option) => [option.symbol, option.open_interest ?? 0])),
      };
      this.oiBaseline.set(key, baseline);
    }

    return list.map((option) => {
      const baselineOi = baseline.oi.get(option.symbol);
      return {
        symbol: option.symbol,
        strike: option.strike,
        optionType: option.option_type,
        openInterest: baselineOi ?? option.open_interest ?? 0,
        bid: option.bid ?? null,
        ask: option.ask ?? null,
        last: option.last ?? null,
        midIv: option.greeks?.mid_iv ?? null,
        delta: option.greeks?.delta ?? null,
        gamma: option.greeks?.gamma ?? null,
      };
    });
  }
}
