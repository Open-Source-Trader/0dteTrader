import {
  BadRequestException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { blackForwardKernel } from './options-analytics.engine';
import { OptionsAnalyticsService } from './options-analytics.service';

const NOW = new Date('2026-07-20T14:00:00.000Z');
const EXPIRATION_A = '2026-08-20';
const EXPIRATION_B = '2026-08-21';

function config(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    'optionsAnalytics.cacheTtlMs': 15_000,
    'optionsAnalytics.cacheHardTtlMs': 120_000,
    'optionsAnalytics.cacheMaxEntries': 2,
    'optionsAnalytics.riskFreeRate': 0.04,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as ConfigService;
}

function chain(expiration: string) {
  const settlement = new Date(`${expiration}T20:00:00.000Z`);
  const timeYears = (settlement.getTime() - NOW.getTime()) / (365 * 86_400_000);
  const call = blackForwardKernel('call', 100, 100, 100, timeYears, 0.2, 1).price;
  const put = blackForwardKernel('put', 100, 100, 100, timeYears, 0.2, 1).price;
  const base = {
    strike: 100,
    openInterest: 100,
    volume: 20,
    bidSize: 10,
    askSize: 10,
    multiplier: 100,
    quoteAsOf: '2026-07-20T13:59:55.000Z',
    last: null,
    lastTradeAsOf: null,
    providerDelta: null,
    providerGamma: null,
    providerImpliedVolatility: null,
    providerGreeksAsOf: '2026-07-20T13:59:50.000Z',
    oiEffectiveDate: '2026-07-17',
    rootSymbol: 'SPY',
  };
  return {
    contractsTotal: 2,
    warnings: [] as string[],
    contracts: [
      {
        ...base,
        symbol: `SPY-${expiration}-C`,
        optionType: 'call' as const,
        bid: call - 0.01,
        ask: call + 0.01,
      },
      {
        ...base,
        symbol: `SPY-${expiration}-P`,
        optionType: 'put' as const,
        bid: put - 0.01,
        ask: put + 0.01,
      },
    ],
  };
}

function client() {
  return {
    calls: { expirations: 0, quote: 0, chain: 0 },
    fail: false,
    availableRequests: 100,
    async getExpirations() {
      this.calls.expirations += 1;
      return [EXPIRATION_A, EXPIRATION_B, '2026-08-24'];
    },
    async getQuote() {
      this.calls.quote += 1;
      if (this.fail) throw new Error('provider unavailable');
      return {
        symbol: 'SPY',
        spot: 100,
        quoteAsOf: '2026-07-20T13:59:58.000Z',
        feedMode: 'realtime' as const,
      };
    },
    async getChain(_symbol: string, expiration: string) {
      this.calls.chain += 1;
      if (this.fail) throw new Error('provider unavailable');
      return chain(expiration);
    },
  };
}

describe('OptionsAnalyticsService exact cache', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('returns 404 for an unavailable exact expiration without fetching another chain', async () => {
    const provider = client();
    const service = new OptionsAnalyticsService(config(), provider as never);

    await expect(service.getSnapshotResult('SPY', '2026-09-01')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(provider.calls.quote).toBe(0);
    expect(provider.calls.chain).toBe(0);
  });

  it.each(['2026-02-29', '2026-02-00', '2026-13-01'])(
    'returns 400 for impossible calendar date %s',
    async (expiration) => {
      const provider = client();
      const service = new OptionsAnalyticsService(config(), provider as never);

      await expect(service.getSnapshotResult('SPY', expiration)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(provider.calls.expirations).toBe(0);
    },
  );

  it('uses an exact-key memory cache and never substitutes another expiration', async () => {
    const provider = client();
    const service = new OptionsAnalyticsService(config(), provider as never);

    const first = await service.getSnapshotResult('spy', EXPIRATION_A);
    const second = await service.getSnapshotResult('SPY', EXPIRATION_A);
    expect(first.snapshot.scope.expiration).toBe(EXPIRATION_A);
    expect(second.snapshot.quality.cacheStatus).toBe('memory-cache');
    expect(provider.calls.chain).toBe(1);

    provider.fail = true;
    await expect(service.getSnapshotResult('SPY', EXPIRATION_B)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('deduplicates concurrent calculations for the same exact key', async () => {
    const provider = client();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = provider.getChain.bind(provider);
    provider.getChain = async (symbol: string, expiration: string) => {
      await gate;
      return original(symbol, expiration);
    };
    const service = new OptionsAnalyticsService(config(), provider as never);

    const one = service.getSnapshotResult('SPY', EXPIRATION_A);
    const two = service.getSnapshotResult('SPY', EXPIRATION_A);
    await Promise.resolve();
    release();
    const [first, second] = await Promise.all([one, two]);

    expect(first.snapshot.scope.expiration).toBe(EXPIRATION_A);
    expect(second.snapshot.scope.expiration).toBe(EXPIRATION_A);
    expect(provider.calls.chain).toBe(1);
  });

  it('joins simultaneous nearest and exact requests after resolving the same expiration', async () => {
    const provider = client();
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const original = provider.getChain.bind(provider);
    provider.getChain = async (symbol: string, expiration: string) => {
      markStarted();
      await gate;
      return original(symbol, expiration);
    };
    const service = new OptionsAnalyticsService(config(), provider as never);

    const nearest = service.getSnapshotResult('SPY');
    const exact = service.getSnapshotResult('SPY', EXPIRATION_A);
    await started;
    release();
    const [nearestResult, exactResult] = await Promise.all([nearest, exact]);

    expect(nearestResult.snapshot.scope.expiration).toBe(EXPIRATION_A);
    expect(exactResult.snapshot.scope.expiration).toBe(EXPIRATION_A);
    expect(provider.calls.expirations).toBe(1);
    expect(provider.calls.quote).toBe(1);
    expect(provider.calls.chain).toBe(1);
  });

  it('serves only the exact stale entry within the hard TTL after provider failure', async () => {
    const provider = client();
    const service = new OptionsAnalyticsService(config(), provider as never);
    await service.getSnapshotResult('SPY', EXPIRATION_A);

    jest.setSystemTime(new Date(NOW.getTime() + 20_000));
    provider.fail = true;
    const fallback = await service.getSnapshotResult('SPY', EXPIRATION_A);

    expect(fallback.snapshot.scope.expiration).toBe(EXPIRATION_A);
    expect(fallback.snapshot.quality.cacheStatus).toBe('stale-fallback');
  });

  it('bounds the LRU and removes entries beyond the hard TTL', async () => {
    const provider = client();
    const service = new OptionsAnalyticsService(config(), provider as never);
    await service.getSnapshotResult('SPY', EXPIRATION_A);
    await service.getSnapshotResult('SPY', EXPIRATION_B);
    await service.getSnapshotResult('SPY', '2026-08-24');

    expect(service.cacheEntryCount).toBe(2);
    jest.setSystemTime(new Date(NOW.getTime() + 121_000));
    provider.fail = true;
    await expect(service.getSnapshotResult('SPY', EXPIRATION_A)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(service.cacheEntryCount).toBeLessThanOrEqual(2);
  });

  it('caches expiration lists for 15 minutes independently of snapshot TTL', async () => {
    const provider = client();
    const service = new OptionsAnalyticsService(config(), provider as never);
    await service.getSnapshotResult('SPY', EXPIRATION_A);
    jest.setSystemTime(new Date(NOW.getTime() + 20_000));
    await service.getSnapshotResult('SPY', EXPIRATION_B);

    expect(provider.calls.expirations).toBe(1);
  });

  it('never serves stale data at settlement or across a New York session boundary', async () => {
    const provider = client();
    provider.getExpirations = async function () {
      this.calls.expirations += 1;
      return ['2026-07-20'];
    };
    const service = new OptionsAnalyticsService(
      config({
        'optionsAnalytics.cacheTtlMs': 12 * 60 * 60_000,
        'optionsAnalytics.cacheHardTtlMs': 12 * 60 * 60_000,
      }),
      provider as never,
    );
    await service.getSnapshotResult('SPY', '2026-07-20');

    jest.setSystemTime(new Date('2026-07-20T20:00:00.000Z'));
    provider.fail = true;
    await expect(service.getSnapshotResult('SPY', '2026-07-20')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('never treats same-day premarket and postmarket as the same cache phase', async () => {
    jest.setSystemTime(new Date('2026-07-20T12:00:00.000Z'));
    const provider = client();
    const service = new OptionsAnalyticsService(
      config({
        'optionsAnalytics.cacheTtlMs': 12 * 60 * 60_000,
        'optionsAnalytics.cacheHardTtlMs': 12 * 60 * 60_000,
      }),
      provider as never,
    );
    await service.getSnapshotResult('SPY', EXPIRATION_A);

    jest.setSystemTime(new Date('2026-07-20T21:00:00.000Z'));
    provider.fail = true;

    await expect(service.getSnapshotResult('SPY', EXPIRATION_A)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('rejects standard SPX analytics at or after the 09:30 ET AM settlement', async () => {
    const provider = client();
    provider.getExpirations = async function () {
      this.calls.expirations += 1;
      return ['2026-07-20'];
    };
    provider.getChain = async function (_symbol: string, expiration: string) {
      this.calls.chain += 1;
      const value = chain(expiration);
      value.contracts.forEach((contract) => {
        contract.rootSymbol = 'SPX';
      });
      return value;
    };
    const service = new OptionsAnalyticsService(config(), provider as never);

    await expect(service.getSnapshotResult('SPX', '2026-07-20')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('prefers SPXW and excludes the SPX AM family from a mixed same-expiration chain', async () => {
    const provider = client();
    provider.getChain = async function (_symbol: string, expiration: string) {
      this.calls.chain += 1;
      const pm = chain(expiration);
      pm.contracts.forEach((contract) => {
        contract.rootSymbol = 'SPXW';
        contract.symbol = contract.symbol.replace('SPY', 'SPXW');
      });
      const am = pm.contracts.map((contract) => ({
        ...contract,
        symbol: contract.symbol.replace('SPXW', 'SPX'),
        rootSymbol: 'SPX',
        openInterest: 100_000,
      }));
      return {
        contractsTotal: 4,
        contractsTotalByRoot: { SPX: 2, SPXW: 2 },
        warnings: [],
        contracts: [...am, ...pm.contracts],
      };
    };
    const service = new OptionsAnalyticsService(config(), provider as never);

    const result = await service.getSnapshotResult('SPX', EXPIRATION_A);

    expect(result.snapshot.scope).toMatchObject({
      rootSymbol: 'SPXW',
      settlementStyle: 'pm',
    });
    expect(result.snapshot.quality.coverage).toMatchObject({
      contractsTotal: 2,
      contractsIncluded: 2,
      ratio: 1,
    });
    expect(result.snapshot.quality.status).toBe('complete');
    expect(result.snapshot.quality.warnings.join(' ')).toMatch(/selected SPXW.*excluded.*SPX/i);
    expect(result.input.contracts.every((contract) => contract.rootSymbol === 'SPXW')).toBe(true);
  });

  it('excludes contracts more than one minute out of sync with the underlying quote', async () => {
    const provider = client();
    provider.getChain = async function (_symbol: string, expiration: string) {
      this.calls.chain += 1;
      const value = chain(expiration);
      const stale = value.contracts.map((contract) => ({
        ...contract,
        symbol: `${contract.symbol}-OUT-OF-SYNC`,
        strike: 105,
        quoteAsOf: '2026-07-20T13:57:00.000Z',
      }));
      return { contractsTotal: 4, warnings: [], contracts: [...value.contracts, ...stale] };
    };
    const service = new OptionsAnalyticsService(config(), provider as never);

    const result = await service.getSnapshotResult('SPY', EXPIRATION_A);

    expect(result.snapshot.quality.coverage).toEqual({
      contractsTotal: 4,
      contractsIncluded: 2,
      ratio: 0.5,
    });
    expect(result.snapshot.quality.warnings.join(' ')).toMatch(/out.of.sync/i);
    expect(result.input.contracts).toHaveLength(2);
  });

  it('returns unavailable when no contracts are synchronized to the underlying quote', async () => {
    const provider = client();
    provider.getChain = async function (_symbol: string, expiration: string) {
      this.calls.chain += 1;
      const value = chain(expiration);
      value.contracts.forEach((contract) => {
        contract.quoteAsOf = '2026-07-20T13:57:00.000Z';
      });
      return value;
    };
    const service = new OptionsAnalyticsService(config(), provider as never);

    await expect(service.getSnapshotResult('SPY', EXPIRATION_A)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
