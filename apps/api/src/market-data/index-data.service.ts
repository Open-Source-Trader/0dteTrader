import { Injectable } from '@nestjs/common';
import { Candle, CandleInterval, Quote } from '@0dtetrader/shared-types';
import { ymd } from '../broker/expiration-calendar';
import { TradierClient } from '../options-analytics/tradier.client';
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
  /** Index quotes are user-independent — one cached fetch serves everyone. */
  private readonly quoteCache = new Map<string, { quote: Quote; at: number }>();

  constructor(private readonly tradier: TradierClient) {}

  isIndexSymbol(symbol: string): boolean {
    return INDEX_SYMBOLS.has(symbol.toUpperCase());
  }

  async getQuote(symbol: string): Promise<Quote> {
    const key = symbol.toUpperCase();
    const cached = this.quoteCache.get(key);
    if (cached && Date.now() - cached.at < IndexDataService.QUOTE_TTL_MS) {
      return cached.quote;
    }
    const quote = await this.tradier.getChartQuote(key);
    this.quoteCache.set(key, { quote, at: Date.now() });
    return quote;
  }

  async getCandles(
    symbol: string,
    interval: CandleInterval,
    from?: string,
    to?: string,
  ): Promise<Candle[]> {
    const key = symbol.toUpperCase();
    const end = to ? new Date(to) : new Date();

    if (interval === '1d' || interval === '1w') {
      const floor = end.getTime() - DAILY_LOOKBACK_MS;
      const start = new Date(Math.max(from ? Date.parse(from) : floor, floor));
      const daily = await this.tradier.getDailyHistory(key, ymd(start), ymd(end));
      return interval === '1w' ? aggregateCandles(daily, '1w') : daily;
    }

    // 30m/1h/4h have no native Tradier interval — aggregate from 15min bars.
    const source = TRADIER_INTRADAY[interval] ?? '15min';
    const floor = end.getTime() - TIMESALES_LOOKBACK_DAYS[source] * DAY_MS;
    const start = new Date(Math.max(from ? Date.parse(from) : floor, floor));
    const rows = await this.tradier.getTimeSales(key, source, start, end);
    return TRADIER_INTRADAY[interval] ? rows : aggregateCandles(rows, interval);
  }
}
