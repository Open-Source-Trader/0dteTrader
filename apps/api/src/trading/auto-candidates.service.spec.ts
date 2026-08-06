import type {
  AutoScoringPreferences,
  OptionsAnalyticsSnapshot,
  OptionsChain,
} from '@0dtetrader/shared-types';
import { Logger } from '@nestjs/common';
import { AutoCandidatesService } from './auto-candidates.service';

const serverTime = new Date('2026-08-05T15:00:04.000Z');
const preferences: AutoScoringPreferences = {
  schemaVersion: 1,
  preset: 'conservative',
  targetAbsDelta: 0.25,
  strikeRungs: 5,
  maxSpreadBps: 500,
  maxPremiumDollars: 250,
  minOpenInterest: 100,
  gammaMode: 'avoid',
  weights: { delta: 0.3, spread: 0.25, openInterest: 0.2, gamma: 0.1, iv: 0.15 },
};

function analytics(): OptionsAnalyticsSnapshot {
  return {
    scope: {
      symbol: 'SPX',
      rootSymbol: 'SPXW',
      settlementStyle: 'pm',
      expiration: '2026-08-05',
      observedAt: '2026-08-05T14:59:30.000Z',
      settlementAt: '2026-08-05T20:00:00.000Z',
      spot: 1,
      forward: 1,
    },
    exposureUnit: '$ delta change per 1% underlying move',
    quality: {
      quoteAsOf: '2026-08-05T14:59:30.000Z',
      greeksAsOf: '2026-08-05T14:59:30.000Z',
      oiEffectiveDate: '2026-08-04',
      feedMode: 'realtime',
      coverage: { contractsTotal: 2, contractsIncluded: 2, ratio: 1 },
      status: 'complete',
      warnings: [],
      calculationVersion: 'options-analytics-v2',
      cacheStatus: 'fresh',
    },
    structure: {
      callGammaExposure: 1,
      putGammaExposure: 1,
      grossGammaExposure: 2,
      callDeltaNotional: 1,
      putDeltaNotional: -1,
      callWall: 6000,
      putWall: 6000,
      grossGammaConcentration: 1,
      maxOpenInterestStrike: 6000,
    },
    scenarios: { callPutDealerProxy: null },
    impliedRange: null,
    strikes: [
      {
        strike: 6000,
        call: {
          openInterest: 150,
          volume: 10,
          impliedVolatility: 0.2,
          delta: 0.25,
          gamma: 0.01,
          gammaExposure: 1,
          deltaNotional: 1,
          markedOiValue: 1,
          relativeSpread: 0.01,
          roundTripCost: 1,
          bidSize: 10,
          askSize: 10,
          multiplier: 100,
        },
        put: null,
        grossGammaExposure: 1,
        totalOpenInterest: 150,
      },
      {
        strike: 6005,
        call: null,
        put: null,
        grossGammaExposure: null,
        totalOpenInterest: 0,
      },
    ],
  };
}

function activeChain(): OptionsChain {
  return {
    underlying: 'SPX',
    underlyingPrice: 6002,
    expirations: ['2026-08-05'],
    contractsExpiration: '2026-08-05',
    contracts: [
      {
        symbol: 'SPXW260805C06000000',
        underlying: 'SPX',
        expiration: '2026-08-05',
        strike: 6000,
        optionType: 'call',
        bid: 2,
        ask: 2.05,
        last: 2.02,
        delta: 0.99,
        gamma: 99,
        impliedVolatility: 9,
        openInterest: 1,
        quoteTimestamp: '2026-08-05T15:00:00.000Z',
      },
      {
        symbol: 'SPXW260805C06005000',
        underlying: 'SPX',
        expiration: '2026-08-05',
        strike: 6005,
        optionType: 'call',
        bid: 2,
        ask: 2.04,
        last: 2.02,
        quoteTimestamp: '2026-08-05T15:00:00.000Z',
      },
    ],
  };
}

describe('AutoCandidatesService', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'log').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('merges Tradier analytics with authenticated active-broker executable quotes', async () => {
    const broker = {
      getOptionsChain: jest.fn().mockResolvedValue(activeChain()),
      executionScope: jest.fn().mockResolvedValue({
        provider: 'webull',
        environment: 'live',
        accountId: 'account-1',
      }),
    };
    const analyticsService = { getSnapshot: jest.fn().mockResolvedValue(analytics()) };
    const storedPreferences = { get: jest.fn() };
    const service = new AutoCandidatesService(
      broker as never,
      analyticsService as never,
      storedPreferences as never,
      () => serverTime,
    );

    const result = await service.rank(
      'user-1',
      { underlying: 'spx', expiration: '2026-08-05', optionType: 'call' },
      preferences,
    );

    expect(broker.getOptionsChain).toHaveBeenCalledWith('user-1', 'SPX', '2026-08-05');
    expect(analyticsService.getSnapshot).toHaveBeenCalledWith('SPX', '2026-08-05', 'user-1');
    expect(result.selectedSymbol).toBe('SPXW260805C06000000');
    if (result.noPass) throw new Error('Expected a passing Auto result.');
    expect(result.rankings[0].candidate).toMatchObject({
      bid: 2,
      ask: 2.05,
      delta: 0.25,
      gamma: 0.01,
      impliedVolatility: 0.2,
      openInterest: 150,
      quoteProvider: 'webull',
      quoteTimestamp: '2026-08-05T15:00:00.000Z',
      analyticsTimestamp: '2026-08-05T14:59:30.000Z',
    });
    expect(result.exclusions).toContainEqual({
      symbol: 'SPXW260805C06005000',
      reason: 'missing_delta',
    });
    expect(service.metrics).toMatchObject({
      requests: 1,
      candidates: 2,
      eligible: 1,
      excluded: 1,
      noPass: 0,
      exclusionCounts: { missing_delta: 1 },
    });
    expect(Logger.prototype.log).toHaveBeenCalledWith(
      expect.stringContaining('"event":"auto_candidates_ranked"'),
    );
  });

  it('loads persisted preferences when the caller does not override them', async () => {
    const broker = {
      getOptionsChain: jest.fn().mockResolvedValue(activeChain()),
      executionScope: jest.fn().mockResolvedValue({ provider: 'alpaca' }),
    };
    const storedPreferences = {
      get: jest.fn().mockResolvedValue({
        schemaVersion: 1,
        preset: 'conservative',
        targetAbsDelta: 0.25,
        strikeRungs: 5,
        maxSpreadBps: 500,
        maxPremiumDollars: 250,
        minOpenInterest: 100,
        gammaMode: 'avoid',
        deltaWeight: 0.3,
        spreadWeight: 0.25,
        openInterestWeight: 0.2,
        gammaWeight: 0.1,
        ivWeight: 0.15,
        createdAt: serverTime.toISOString(),
        updatedAt: serverTime.toISOString(),
      }),
    };
    const service = new AutoCandidatesService(
      broker as never,
      { getSnapshot: jest.fn().mockResolvedValue(analytics()) } as never,
      storedPreferences as never,
      () => serverTime,
    );

    await service.rank('user-2', {
      underlying: 'SPX',
      expiration: '2026-08-05',
      optionType: 'call',
    });

    expect(storedPreferences.get).toHaveBeenCalledWith('user-2');
  });

  it('rejects a mismatched active-broker chain instead of scoring the wrong symbol or expiration', async () => {
    const chain = activeChain();
    chain.underlying = 'NDX';
    const service = new AutoCandidatesService(
      {
        getOptionsChain: jest.fn().mockResolvedValue(chain),
        executionScope: jest.fn().mockResolvedValue({ provider: 'webull' }),
      } as never,
      { getSnapshot: jest.fn().mockResolvedValue(analytics()) } as never,
      { get: jest.fn() } as never,
      () => serverTime,
    );

    await expect(
      service.rank(
        'user-1',
        { underlying: 'SPX', expiration: '2026-08-05', optionType: 'call' },
        preferences,
      ),
    ).rejects.toThrow(/active-broker chain/i);
  });
});
