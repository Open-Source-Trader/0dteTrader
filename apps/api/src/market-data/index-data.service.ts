import { Injectable, Optional } from '@nestjs/common';
import { Candle, CandleInterval, Quote } from '@0dtetrader/shared-types';
import { ymd } from '../broker/expiration-calendar';
import { brokerErrors } from '../common/broker-error';
import { TradierClient } from '../options-analytics/tradier.client';
import {
  TradierClientResolver,
  type ResolvedTradier,
} from '../options-analytics/tradier-client.resolver';
import { aggregateCandles } from './candle-aggregation';

/** Index symbols charted via Tradier — Webull's OpenAPI has no index
 *  market-data category, so these bypass the broker gateway (like crypto).
 *  Indices are quote-only: not tradeable, no options chain here. */
export const INDEX_SYMBOLS = new Set(['SPX', 'NDX', 'VIX']);

/** Tradier's native intraday timesales intervals. */
const TRADIER_INTRADAY: Partial<Record<CandleInterval, '1min' | '5min' | '15min'>> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
};

/** Timesales lookback per source interval (Tradier: 1min ~20 days,
 *  5min/15min ~40 days of history). */
const TIMESALES_LOOKBACK_DAYS: Record<'1min' | '5min' | '15min', number> = {
  '1min': 10,
  '5min': 35,
  '15min': 35,
};

const DAY_MS = 86_400_000;
/** Daily-history lookback cap (~250 trading days/yr; weekly needs years). */
const DAILY_LOOKBACK_MS = 1_200 * DAY_MS;

@Injectable()
export class IndexDataService {
  private static readonly QUOTE_TTL_MS = 4_000;
  /** Cached per Tradier-client scope: within a scope the data is identical
   *  for everyone, but a per-user (possibly sandbox) client's quotes must
   *  not be served to callers on a different key. */
  private readonly quoteCache = new Map<string, { quote: Quote; at: number }>();

  constructor(
    private readonly tradier: TradierClient,
    @Optional() private readonly tradierResolver?: TradierClientResolver,
  ) {}

  /** Per-user Tradier client when a user context and stored key exist; the
   *  shared env-token client otherwise (e.g. StreamGateway's shared poll). */
  private async clientFor(userId?: string): Promise<ResolvedTradier> {
    if (userId && this.tradierResolver) return this.tradierResolver.resolve(userId);
    return { client: this.tradier, scope: 'shared' };
  }

  isIndexSymbol(symbol: string): boolean {
    return INDEX_SYMBOLS.has(symbol.toUpperCase());
  }

  async getQuote(symbol: string, userId?: string): Promise<Quote> {
    const { client, scope } = await this.clientFor(userId);
    const key = `${scope}:${symbol.toUpperCase()}`;
    const now = Date.now();
    const cached = this.quoteCache.get(key);
    if (cached && now - cached.at < IndexDataService.QUOTE_TTL_MS) {
      return cached.quote;
    }
    const quote = await this.wrap(() => client.getChartQuote(symbol.toUpperCase()));
    this.quoteCache.set(key, { quote, at: Date.now() });
    // Scope-keyed entries die whenever a user's client is rebuilt, so sweep
    // expired ones on write — without this the map grows for the process
    // lifetime (the TTL above only gates reads).
    for (const [staleKey, entry] of this.quoteCache) {
      if (Date.now() - entry.at >= IndexDataService.QUOTE_TTL_MS) this.quoteCache.delete(staleKey);
    }
    return quote;
  }

  /** Tradier failures surface as the same user-safe broker errors the crypto
   *  path uses, not raw 500s. */
  private async wrap<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      const message = (err as Error).message ?? '';
      if (/rate limit/i.test(message)) {
        throw brokerErrors.rateLimited('Index data source rate limit exceeded');
      }
      throw brokerErrors.unavailable(`Index data source error: ${message}`);
    }
  }

  async getCandles(
    symbol: string,
    interval: CandleInterval,
    from?: string,
    to?: string,
    userId?: string,
  ): Promise<Candle[]> {
    const { client } = await this.clientFor(userId);
    const key = symbol.toUpperCase();
    const end = to ? new Date(to) : new Date();

    if (interval === '1d' || interval === '1w') {
      const floor = end.getTime() - DAILY_LOOKBACK_MS;
      const start = new Date(Math.max(from ? Date.parse(from) : floor, floor));
      const daily = await this.wrap(() => client.getDailyHistory(key, ymd(start), ymd(end)));
      return interval === '1w' ? aggregateCandles(daily, '1w') : daily;
    }

    // 30m/1h/4h have no native Tradier interval — aggregate from 15min bars.
    const source = TRADIER_INTRADAY[interval] ?? '15min';
    const floor = end.getTime() - TIMESALES_LOOKBACK_DAYS[source] * DAY_MS;
    const start = new Date(Math.max(from ? Date.parse(from) : floor, floor));
    const rows = await this.wrap(() => client.getTimeSales(key, source, start, end));
    return TRADIER_INTRADAY[interval] ? rows : aggregateCandles(rows, interval);
  }
}
