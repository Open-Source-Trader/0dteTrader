import { ConfigService } from '@nestjs/config';
import { TradierClient } from '../options-analytics/tradier.client';
import { TradierMarketDataService } from './tradier-market-data.service';

const NOW = new Date('2026-07-28T14:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function makeService(): {
  service: TradierMarketDataService;
  getTimeSales: jest.SpyInstance;
  getDailyHistory: jest.SpyInstance;
} {
  const tradier = new TradierClient('token', 'https://api.tradier.com');
  const getTimeSales = jest.spyOn(tradier, 'getTimeSales').mockResolvedValue([]);
  const getDailyHistory = jest.spyOn(tradier, 'getDailyHistory').mockResolvedValue([]);
  const service = new TradierMarketDataService(tradier, new ConfigService({}));
  return { service, getTimeSales, getDailyHistory };
}

describe('TradierMarketDataService.getCandles lookback clamping', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('clamps an unbounded 1m request to the 40-day cap instead of passing it through', async () => {
    const { service, getTimeSales } = makeService();
    await service.getCandles('SPY', {
      interval: '1m',
      from: '1970-01-01T00:00:00.000Z',
      to: NOW.toISOString(),
    });
    const [, , start, end] = getTimeSales.mock.calls[0] as [string, string, Date, Date];
    expect(end.getTime()).toBe(NOW.getTime());
    expect(start.getTime()).toBe(NOW.getTime() - 40 * DAY_MS);
  });

  it('leaves a 1m request already inside the cap untouched', async () => {
    const { service, getTimeSales } = makeService();
    const from = new Date(NOW.getTime() - 5 * DAY_MS);
    await service.getCandles('SPY', {
      interval: '1m',
      from: from.toISOString(),
      to: NOW.toISOString(),
    });
    const [, , start] = getTimeSales.mock.calls[0] as [string, string, Date, Date];
    expect(start.getTime()).toBe(from.getTime());
  });

  it('clamps an unbounded 4h request (sourced from 1m bars) to the 1m cap, not a 4h-scaled one', async () => {
    const { service, getTimeSales } = makeService();
    await service.getCandles('SPY', {
      interval: '4h',
      from: '1970-01-01T00:00:00.000Z',
      to: NOW.toISOString(),
    });
    const [, interval, start] = getTimeSales.mock.calls[0] as [string, string, Date, Date];
    expect(interval).toBe('1min');
    expect(start.getTime()).toBe(NOW.getTime() - 40 * DAY_MS);
  });

  it('clamps an unbounded 1d request to the 10-year cap', async () => {
    const { service, getDailyHistory } = makeService();
    await service.getCandles('SPY', {
      interval: '1d',
      from: '1970-01-01T00:00:00.000Z',
      to: NOW.toISOString(),
    });
    const [, start] = getDailyHistory.mock.calls[0] as [string, string, string];
    expect(start).toBe(new Date(NOW.getTime() - 10 * 365 * DAY_MS).toISOString().slice(0, 10));
  });

  it('defaults an omitted from to the interval cap rather than an unbounded range', async () => {
    const { service, getTimeSales } = makeService();
    await service.getCandles('SPY', { interval: '5m' });
    const [, , start, end] = getTimeSales.mock.calls[0] as [string, string, Date, Date];
    expect(end.getTime()).toBe(NOW.getTime());
    expect(start.getTime()).toBe(NOW.getTime() - 90 * DAY_MS);
  });
});
