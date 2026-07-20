import { Candle, Quote } from '@0dtetrader/shared-types';
import { BrokerError } from '../common/broker-error';
import { TradierClient } from '../options-analytics/tradier.client';
import { IndexDataService } from './index-data.service';

function quoteFor(symbol: string): Quote {
  return {
    symbol,
    bid: 0,
    ask: 0,
    last: 6300,
    bidSize: 0,
    askSize: 0,
    volume: 0,
    timestamp: '2026-07-17T14:30:00.000Z',
  };
}

function candle(time: string): Candle {
  return { time, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 };
}

describe('IndexDataService', () => {
  let tradier: {
    getChartQuote: jest.Mock;
    getDailyHistory: jest.Mock;
    getTimeSales: jest.Mock;
  };
  let service: IndexDataService;

  beforeEach(() => {
    tradier = {
      getChartQuote: jest.fn(async (symbol: string) => quoteFor(symbol)),
      getDailyHistory: jest.fn(async () => [
        candle('2026-07-13T00:00:00.000Z'),
        candle('2026-07-14T00:00:00.000Z'),
      ]),
      getTimeSales: jest.fn(async () => [
        candle('2026-07-17T14:00:00.000Z'),
        candle('2026-07-17T14:15:00.000Z'),
      ]),
    };
    service = new IndexDataService(tradier as unknown as TradierClient);
  });

  it('recognizes only the curated index symbols, case-insensitively', () => {
    expect(service.isIndexSymbol('SPX')).toBe(true);
    expect(service.isIndexSymbol('ndx')).toBe(true);
    expect(service.isIndexSymbol('VIX')).toBe(true);
    expect(service.isIndexSymbol('SPY')).toBe(false);
    expect(service.isIndexSymbol('BTC')).toBe(false);
  });

  it('serves quotes from the shared cache within the TTL', async () => {
    await service.getQuote('SPX');
    await service.getQuote('spx');
    expect(tradier.getChartQuote).toHaveBeenCalledTimes(1);
  });

  it('routes native intraday intervals to timesales without aggregation', async () => {
    const candles = await service.getCandles('SPX', '15m');
    expect(tradier.getTimeSales).toHaveBeenCalledWith(
      'SPX',
      '15min',
      expect.any(Date),
      expect.any(Date),
    );
    expect(candles).toHaveLength(2);
  });

  it('aggregates 30m from 15min timesales bars', async () => {
    const candles = await service.getCandles('SPX', '30m');
    expect(tradier.getTimeSales).toHaveBeenCalledWith(
      'SPX',
      '15min',
      expect.any(Date),
      expect.any(Date),
    );
    // Both 15m bars fall in the 14:00 half-hour bucket.
    expect(candles).toEqual([
      { time: '2026-07-17T14:00:00.000Z', open: 1, high: 2, low: 0.5, close: 1.5, volume: 20 },
    ]);
  });

  it('serves 1d from daily history and 1w as Monday-aligned weekly bars', async () => {
    const daily = await service.getCandles('NDX', '1d');
    expect(daily).toHaveLength(2);

    const weekly = await service.getCandles('NDX', '1w');
    // Mon 07-13 and Tue 07-14 collapse into the Monday bucket.
    expect(weekly).toHaveLength(1);
    expect(weekly[0].time).toBe('2026-07-13T00:00:00.000Z');
  });

  it('wraps Tradier failures as user-safe broker errors', async () => {
    tradier.getChartQuote.mockRejectedValue(new Error('Tradier /markets/quotes -> HTTP 502'));
    await expect(service.getQuote('VIX')).rejects.toBeInstanceOf(BrokerError);

    tradier.getTimeSales.mockRejectedValue(
      new Error('Tradier rate limit is exhausted until 2026-07-17T15:00:00.000Z'),
    );
    const rateLimited = await service.getCandles('VIX', '1m').catch((err) => err as BrokerError);
    expect(rateLimited).toBeInstanceOf(BrokerError);
    expect((rateLimited as BrokerError).message).toContain('rate limit');
  });
});
