import { Injectable, Logger } from '@nestjs/common';
import { Candle, CandleInterval, Quote } from '@0dtetrader/shared-types';
import { brokerErrors } from '../common/broker-error';

/**
 * Live cryptocurrency market data from Coinbase Exchange's public REST API
 * (no credentials required, 24/7). Webull's OpenAPI has no crypto market-data
 * category, so crypto symbols bypass the broker gateway for quotes/candles;
 * trading still goes through the configured gateway.
 */
@Injectable()
export class CryptoDataService {
  private readonly logger = new Logger(CryptoDataService.name);
  private readonly baseUrl = 'https://api.exchange.coinbase.com';

  /** Chart symbol → Coinbase product id. */
  private static readonly PRODUCTS: Record<string, string> = {
    BTC: 'BTC-USD',
    ETH: 'ETH-USD',
    SOL: 'SOL-USD',
    XRP: 'XRP-USD',
    DOGE: 'DOGE-USD',
    ADA: 'ADA-USD',
    AVAX: 'AVAX-USD',
    LINK: 'LINK-USD',
    LTC: 'LTC-USD',
  };

  static readonly SYMBOLS = Object.keys(CryptoDataService.PRODUCTS);

  private static readonly GRANULARITY: Record<CandleInterval, number> = {
    '1m': 60,
    '5m': 300,
    '15m': 900,
    '30m': 1800,
    '1h': 3600,
    '4h': 14400,
    '1d': 86400,
  };

  isCryptoSymbol(symbol: string): boolean {
    return symbol.toUpperCase() in CryptoDataService.PRODUCTS;
  }

  async getQuote(symbol: string): Promise<Quote> {
    const product = this.product(symbol);
    const ticker = await this.fetchJson<{
      bid: string;
      ask: string;
      price: string;
      size: string;
      volume: string;
      time: string;
    }>(`/products/${product}/ticker`);
    return {
      symbol: symbol.toUpperCase(),
      bid: Number(ticker.bid),
      ask: Number(ticker.ask),
      last: Number(ticker.price),
      // The ticker carries no order-book sizes — report 0 rather than
      // inventing liquidity that isn't there.
      bidSize: 0,
      askSize: 0,
      volume: Math.round(Number(ticker.volume)),
      timestamp: ticker.time ?? new Date().toISOString(),
    };
  }

  async getCandles(
    symbol: string,
    interval: CandleInterval,
    from?: string,
    to?: string,
  ): Promise<Candle[]> {
    const product = this.product(symbol);
    const granularity = CryptoDataService.GRANULARITY[interval];
    // Coinbase caps responses at 300 buckets per request.
    const end = to ? new Date(to) : new Date();
    const maxSpanMs = granularity * 300 * 1000;
    let start = from ? new Date(from) : new Date(end.getTime() - maxSpanMs);
    if (end.getTime() - start.getTime() > maxSpanMs) {
      start = new Date(end.getTime() - maxSpanMs);
    }
    const query = new URLSearchParams({
      granularity: String(granularity),
      start: start.toISOString(),
      end: end.toISOString(),
    });
    // Rows: [bucketStartEpochSeconds, low, high, open, close, volume], newest first.
    const rows = await this.fetchJson<[number, number, number, number, number, number][]>(
      `/products/${product}/candles?${query.toString()}`,
    );
    return rows
      .map(([time, low, high, open, close, volume]) => ({
        time: new Date(time * 1000).toISOString(),
        open,
        high,
        low,
        close,
        volume: Math.round(volume),
      }))
      .reverse();
  }

  private product(symbol: string): string {
    const product = CryptoDataService.PRODUCTS[symbol.toUpperCase()];
    if (!product) {
      throw brokerErrors.contractNotFound(`Unknown crypto symbol: ${symbol}`);
    }
    return product;
  }

  private async fetchJson<T>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        headers: { 'User-Agent': '0dteTrader/0.1' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      this.logger.warn(`coinbase request failed: ${(err as Error).message}`);
      throw brokerErrors.unavailable('Crypto data source is unreachable');
    }
    if (response.status === 429) {
      throw brokerErrors.rateLimited('Crypto data source rate limit exceeded');
    }
    if (!response.ok) {
      throw brokerErrors.unavailable(`Crypto data source error (HTTP ${response.status})`);
    }
    return (await response.json()) as T;
  }
}
