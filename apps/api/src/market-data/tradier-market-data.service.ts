import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Candle,
  CandleInterval,
  CandleRequest,
  OptionsChain,
  Quote,
} from '@0dtetrader/shared-types';
import { TradierClient } from '../options-analytics/tradier.client';
import { aggregateCandles } from './candle-aggregation';

const TRADIER_INTRADAY_INTERVALS = new Set<CandleInterval>(['1m', '5m', '15m']);
const TRADIER_DAILY_INTERVALS = new Set<CandleInterval>(['1d', '1w']);

/**
 * Market-data provider backed by Tradier. Used by {@link MarketDataController}
 * for quotes, candles, and options-chain regardless of the user's selected
 * trading broker (Webull / Alpaca / SnapTrade).
 *
 * Why Tradier for everything:
 * - Quotes: 1 call to /markets/quotes
 * - Options chain + Greeks: 1 call to /markets/options/chains?greeks=true
 *   (Alpaca needs 2+ calls; Webull probes multiple optionSnapshot batches)
 * - Candles: 1 call to /markets/timesales (1m/5m/15m) or /markets/history (1d/1w)
 *
 * Intervals Tradier cannot serve natively (30m, 1h, 4h) are aggregated from
 * 1m time-sales data in a single upstream call.
 */
@Injectable()
export class TradierMarketDataService {
  private readonly logger = new Logger(TradierMarketDataService.name);

  constructor(
    private readonly tradier: TradierClient,
    private readonly config: ConfigService,
  ) {}

  async getQuote(symbol: string): Promise<Quote> {
    return this.tradier.getChartQuote(symbol);
  }

  async getCandles(symbol: string, req: CandleRequest): Promise<Candle[]> {
    const interval = req.interval;
    const from = req.from ? new Date(req.from) : undefined;
    const to = req.to ? new Date(req.to) : undefined;

    // 1) Native Tradier intraday: 1m / 5m / 15m via /markets/timesales.
    if (TRADIER_INTRADAY_INTERVALS.has(interval)) {
      const end = to ?? new Date();
      // Tradier ~20/40-day lookback; if the caller asked further back, honor
      // the request and let Tradier return what it can.
      const start = from ?? new Date(end.getTime() - 40 * 24 * 60 * 60 * 1000);
      return this.tradier.getTimeSales(
        symbol,
        interval === '1m' ? '1min' : interval === '5m' ? '5min' : '15min',
        start,
        end,
      );
    }

    // 2) Native Tradier daily/weekly: /markets/history?interval=daily.
    if (TRADIER_DAILY_INTERVALS.has(interval)) {
      const end = to ?? new Date();
      // Default to ~2 years of history when no range is requested.
      const start = from ?? new Date(end.getTime() - 730 * 24 * 60 * 60 * 1000);
      const daily = await this.tradier.getDailyHistory(
        symbol,
        this.tradierToDate(start),
        this.tradierToDate(end),
      );
      if (interval === '1w') return aggregateCandles(daily, '1w');
      return daily;
    }

    // 3) 30m / 1h / 4h: Tradier has no native bar. Aggregate from 1m
    //    time-sales in a single upstream call.
    const end = to ?? new Date();
    const start = from ?? new Date(end.getTime() - 40 * 24 * 60 * 60 * 1000);
    const oneMin = await this.tradier.getTimeSales(symbol, '1min', start, end);
    if (oneMin.length === 0) return [];
    return aggregateCandles(oneMin, interval);
  }

  async getOptionsChain(symbol: string, expiration?: string): Promise<OptionsChain> {
    const normalizedSymbol = symbol.trim().toUpperCase();
    if (!/^[A-Z0-9.-]{1,12}$/.test(normalizedSymbol)) {
      throw new Error(`A valid symbol is required (for example, SPY)`);
    }
    const expirations = await this.tradier.getExpirations(normalizedSymbol);
    const selected = expiration && expirations.includes(expiration) ? expiration : expirations[0];
    if (!selected) {
      throw new Error(`No option expirations are available for ${normalizedSymbol}`);
    }
    const [quote, chain] = await Promise.all([
      this.tradier.getQuote(normalizedSymbol),
      this.tradier.getChain(normalizedSymbol, selected),
    ]);
    const contracts = chain.contracts.map((c) => ({
      symbol: c.symbol,
      underlying: normalizedSymbol,
      expiration: selected,
      strike: c.strike,
      optionType: c.optionType as 'call' | 'put',
      bid: c.bid,
      ask: c.ask,
      last: c.last ?? 0,
    }));
    return {
      underlying: normalizedSymbol,
      underlyingPrice: quote.spot,
      expirations,
      contracts,
    };
  }

  /** Convert any date to YYYY-MM-DD for Tradier's history endpoint. */
  private tradierToDate(date: Date): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}
