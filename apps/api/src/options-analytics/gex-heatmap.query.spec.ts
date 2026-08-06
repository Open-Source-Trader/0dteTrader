import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type {
  OptionsAnalyticsSnapshot,
  OptionsAnalyticsStrike,
  OptionsAnalyticsStrikeLeg,
} from '@0dtetrader/shared-types';
import { InMemoryPrismaService } from '../../test/in-memory-prisma.service';
import type { OptionsAnalyticsSnapshotResult } from './options-analytics.service';
import { OptionsAnalyticsCaptureService } from './options-analytics.capture';
import { GexHeatmapQueryService } from './gex-heatmap.query';

const NOW = new Date('2026-07-20T15:00:30.000Z');

function leg(overrides: Partial<OptionsAnalyticsStrikeLeg> = {}): OptionsAnalyticsStrikeLeg {
  return {
    openInterest: 100,
    volume: 10,
    impliedVolatility: 0.2,
    delta: 0.5,
    gamma: 0.01,
    gammaExposure: 5_000,
    deltaNotional: 1_000,
    markedOiValue: 2_000,
    relativeSpread: 0.01,
    roundTripCost: 1,
    bidSize: 5,
    askSize: 5,
    multiplier: 100,
    ...overrides,
  };
}

function strikeRow(
  strike: number,
  call: OptionsAnalyticsStrikeLeg | null,
  put: OptionsAnalyticsStrikeLeg | null,
): OptionsAnalyticsStrike {
  const legs = [call?.gammaExposure, put?.gammaExposure].filter(
    (value): value is number => value !== null && value !== undefined,
  );
  return {
    strike,
    call,
    put,
    grossGammaExposure: legs.length === 0 ? null : legs.reduce((sum, v) => sum + v, 0),
    totalOpenInterest: (call?.openInterest ?? 0) + (put?.openInterest ?? 0),
  };
}

function snapshot(
  symbol: string,
  expiration: string,
  observedAt: Date,
  spot: number,
  strikes: OptionsAnalyticsStrike[],
): OptionsAnalyticsSnapshot {
  return {
    scope: {
      symbol,
      rootSymbol: symbol,
      settlementStyle: 'pm',
      expiration,
      observedAt: observedAt.toISOString(),
      settlementAt: '2026-07-20T20:00:00.000Z',
      spot,
      forward: spot,
    },
    exposureUnit: '$ delta change per 1% underlying move',
    quality: {
      quoteAsOf: observedAt.toISOString(),
      greeksAsOf: observedAt.toISOString(),
      oiEffectiveDate: '2026-07-17',
      feedMode: 'realtime',
      coverage: {
        contractsTotal: strikes.length * 2,
        contractsIncluded: strikes.length * 2,
        ratio: 1,
      },
      status: 'complete',
      warnings: [],
      calculationVersion: 'options-analytics-v1',
      cacheStatus: 'fresh',
    },
    structure: {
      callGammaExposure: null,
      putGammaExposure: null,
      grossGammaExposure: null,
      callDeltaNotional: null,
      putDeltaNotional: null,
      callWall: null,
      putWall: null,
      grossGammaConcentration: null,
      maxOpenInterestStrike: null,
    },
    scenarios: { callPutDealerProxy: null },
    impliedRange: null,
    strikes,
  };
}

function result(
  symbol: string,
  observedAt: Date,
  spot: number,
  strikes: OptionsAnalyticsStrike[],
  expiration = '2026-07-20',
): OptionsAnalyticsSnapshotResult {
  const output = snapshot(symbol, expiration, observedAt, spot, strikes);
  return {
    snapshot: output,
    scope: 'shared',
    input: {
      symbol,
      rootSymbol: symbol,
      settlementStyle: 'pm',
      expiration,
      observedAt: output.scope.observedAt,
      settlementAt: output.scope.settlementAt,
      riskFreeRate: 0.04,
      quote: {
        symbol,
        spot,
        quoteAsOf: output.scope.observedAt,
        feedMode: 'realtime',
        completedSessionDate: null,
        warnings: [],
      },
      contractsTotal: 0,
      contracts: [],
      warnings: [],
    },
  };
}

function config(): ConfigService {
  return { get: () => undefined } as unknown as ConfigService;
}

describe('GexHeatmapQueryService', () => {
  let prisma: InMemoryPrismaService;
  let capture: OptionsAnalyticsCaptureService;
  let query: GexHeatmapQueryService;

  beforeEach(() => {
    prisma = new InMemoryPrismaService();
    capture = new OptionsAnalyticsCaptureService(prisma as never, {} as never, config());
    query = new GexHeatmapQueryService(prisma as never);
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('produces positive callGex and negative putGex, netting to their sum', async () => {
    const row = result('SPY', NOW, 100, [
      strikeRow(100, leg({ gammaExposure: 5_000 }), leg({ gammaExposure: 3_000 })),
    ]);
    await capture.persist(row, 'viewed', NOW);

    const heatmap = await query.getHeatmap(
      {
        symbol: 'SPY',
        expiration: '2026-07-20',
        from: new Date(NOW.getTime() - 60_000),
        to: new Date(NOW.getTime() + 1),
      },
      NOW,
    );

    expect(heatmap.cells).toHaveLength(1);
    expect(heatmap.cells[0].callGex).toBe(5_000);
    expect(heatmap.cells[0].putGex).toBe(-3_000);
    expect(heatmap.cells[0].netGex).toBe(2_000);
  });

  it('aggregates multiple strikes independently and sorts them ascending', async () => {
    const row = result('SPY', NOW, 100, [
      strikeRow(105, leg({ gammaExposure: 1_000 }), null),
      strikeRow(95, null, leg({ gammaExposure: 2_000 })),
      strikeRow(100, leg({ gammaExposure: 500 }), leg({ gammaExposure: 500 })),
    ]);
    await capture.persist(row, 'viewed', NOW);

    const heatmap = await query.getHeatmap(
      {
        symbol: 'SPY',
        expiration: '2026-07-20',
        from: new Date(NOW.getTime() - 60_000),
        to: new Date(NOW.getTime() + 1),
      },
      NOW,
    );

    expect(heatmap.strikes).toEqual([95, 100, 105]);
    const byStrike = new Map(heatmap.cells.map((cell) => [cell.strike, cell]));
    expect(byStrike.get(95)).toMatchObject({ callGex: null, putGex: -2_000, netGex: -2_000 });
    expect(byStrike.get(100)).toMatchObject({ callGex: 500, putGex: -500, netGex: 0 });
    expect(byStrike.get(105)).toMatchObject({ callGex: 1_000, putGex: null, netGex: 1_000 });
  });

  it('does not convert missing gamma into zero and flags the cell missingGamma', async () => {
    const row = result('SPY', NOW, 100, [
      strikeRow(100, leg({ gamma: null, gammaExposure: null }), leg({ gammaExposure: 1_000 })),
    ]);
    await capture.persist(row, 'viewed', NOW);

    const heatmap = await query.getHeatmap(
      {
        symbol: 'SPY',
        expiration: '2026-07-20',
        from: new Date(NOW.getTime() - 60_000),
        to: new Date(NOW.getTime() + 1),
      },
      NOW,
    );

    expect(heatmap.cells[0].callGex).toBeNull();
    expect(heatmap.cells[0].netGex).toBe(-1_000);
    expect(heatmap.cells[0].dataQuality).toBe('missingGamma');
  });

  it('flags an absent leg (missing open interest / no contract) rather than treating it as zero', async () => {
    const row = result('SPY', NOW, 100, [strikeRow(100, leg({ gammaExposure: 2_000 }), null)]);
    await capture.persist(row, 'viewed', NOW);

    const heatmap = await query.getHeatmap(
      {
        symbol: 'SPY',
        expiration: '2026-07-20',
        from: new Date(NOW.getTime() - 60_000),
        to: new Date(NOW.getTime() + 1),
      },
      NOW,
    );

    expect(heatmap.cells[0].putGex).toBeNull();
    expect(heatmap.cells[0].netGex).toBe(2_000);
    expect(heatmap.cells[0].dataQuality).toBe('missingOpenInterest');
  });

  it('marks the most recent snapshot stale when it exceeds the freshness threshold, but not older ones', async () => {
    const stale = new Date(NOW.getTime() - 5 * 60_000);
    const row = result('SPY', stale, 100, [strikeRow(100, leg(), leg())]);
    await capture.persist(row, 'viewed', stale);

    const heatmap = await query.getHeatmap(
      {
        symbol: 'SPY',
        expiration: '2026-07-20',
        from: new Date(stale.getTime() - 60_000),
        to: new Date(NOW.getTime() + 1),
      },
      NOW,
    );

    expect(heatmap.cells[0].dataQuality).toBe('stale');
  });

  it('is deterministic: repeated calls with identical stored inputs produce identical output', async () => {
    const row = result('SPY', NOW, 100, [
      strikeRow(100, leg({ gammaExposure: 1_000 }), leg({ gammaExposure: 500 })),
    ]);
    await capture.persist(row, 'viewed', NOW);

    const params = {
      symbol: 'SPY',
      expiration: '2026-07-20',
      from: new Date(NOW.getTime() - 60_000),
      to: new Date(NOW.getTime() + 1),
    };
    const first = await query.getHeatmap(params, NOW);
    const second = await query.getHeatmap(params, NOW);
    expect(first).toEqual(second);
  });

  it('respects the requested time range, excluding snapshots outside the window', async () => {
    const inWindow = result('SPY', NOW, 100, [strikeRow(100, leg(), leg())]);
    const outOfWindow = result('SPY', new Date(NOW.getTime() - 10 * 60_000), 100, [
      strikeRow(100, leg(), leg()),
    ]);
    await capture.persist(inWindow, 'viewed', NOW);
    await capture.persist(outOfWindow, 'viewed', new Date(NOW.getTime() - 10 * 60_000));

    const heatmap = await query.getHeatmap(
      {
        symbol: 'SPY',
        expiration: '2026-07-20',
        from: new Date(NOW.getTime() - 60_000),
        to: new Date(NOW.getTime() + 1),
      },
      NOW,
    );

    expect(heatmap.timestamps).toHaveLength(1);
    expect(heatmap.timestamps[0]).toBe(NOW.toISOString());
  });

  it('excludes strikes outside the configured window around spot', async () => {
    const row = result('SPY', NOW, 100, [
      strikeRow(80, leg(), leg()),
      strikeRow(100, leg(), leg()),
      strikeRow(120, leg(), leg()),
    ]);
    await capture.persist(row, 'viewed', NOW);

    const heatmap = await query.getHeatmap(
      {
        symbol: 'SPY',
        expiration: '2026-07-20',
        from: new Date(NOW.getTime() - 60_000),
        to: new Date(NOW.getTime() + 1),
        strikeRangeAboveSpot: 10,
        strikeRangeBelowSpot: 10,
      },
      NOW,
    );

    expect(heatmap.strikes).toEqual([100]);
  });

  it('downsamples to one column per bucketMinutes, keeping the latest snapshot in each bucket', async () => {
    const minute0 = new Date(NOW.getTime() - 4 * 60_000);
    const minute1 = new Date(NOW.getTime() - 3 * 60_000);
    const minute5 = new Date(NOW.getTime() - 0);
    await capture.persist(
      result('SPY', minute0, 100, [
        strikeRow(100, leg({ gammaExposure: 100 }), leg({ gammaExposure: 100 })),
      ]),
      'viewed',
      minute0,
    );
    await capture.persist(
      result('SPY', minute1, 100, [
        strikeRow(100, leg({ gammaExposure: 200 }), leg({ gammaExposure: 100 })),
      ]),
      'viewed',
      minute1,
    );
    await capture.persist(
      result('SPY', minute5, 100, [
        strikeRow(100, leg({ gammaExposure: 999 }), leg({ gammaExposure: 100 })),
      ]),
      'viewed',
      minute5,
    );

    const heatmap = await query.getHeatmap(
      {
        symbol: 'SPY',
        expiration: '2026-07-20',
        from: new Date(minute0.getTime() - 1),
        to: new Date(NOW.getTime() + 1),
        bucketMinutes: 5,
      },
      NOW,
    );

    // minute0 and minute1 fall in the same 5-minute bucket; minute1 (the
    // later one) is the representative, so its callGex (200) wins over
    // minute0's (100). minute5 is its own bucket.
    expect(heatmap.timestamps).toHaveLength(2);
    expect(heatmap.cells.map((c) => c.callGex)).toEqual([200, 999]);
  });

  it('bucketMinutes of 1 (or omitted) leaves every 1-minute snapshot as its own column', async () => {
    const minuteA = new Date(NOW.getTime() - 60_000);
    const minuteB = NOW;
    await capture.persist(
      result('SPY', minuteA, 100, [strikeRow(100, leg(), leg())]),
      'viewed',
      minuteA,
    );
    await capture.persist(
      result('SPY', minuteB, 100, [strikeRow(100, leg(), leg())]),
      'viewed',
      minuteB,
    );

    const heatmap = await query.getHeatmap(
      {
        symbol: 'SPY',
        expiration: '2026-07-20',
        from: new Date(minuteA.getTime() - 1),
        to: new Date(minuteB.getTime() + 1),
      },
      NOW,
    );

    expect(heatmap.timestamps).toHaveLength(2);
  });
});

describe('GexHeatmapQueryService.getTermStructure', () => {
  let prisma: InMemoryPrismaService;
  let capture: OptionsAnalyticsCaptureService;
  let query: GexHeatmapQueryService;

  beforeEach(() => {
    prisma = new InMemoryPrismaService();
    capture = new OptionsAnalyticsCaptureService(prisma as never, {} as never, config());
    query = new GexHeatmapQueryService(prisma as never);
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('picks the single latest snapshot for each expiration, sorted ascending', async () => {
    const near = result(
      'SPY',
      new Date(NOW.getTime() - 30_000),
      100,
      [strikeRow(100, leg({ gammaExposure: 1_000 }), leg({ gammaExposure: 500 }))],
      '2026-07-21',
    );
    const nearOlder = result(
      'SPY',
      new Date(NOW.getTime() - 90_000),
      100,
      [strikeRow(100, leg({ gammaExposure: 1 }), leg({ gammaExposure: 1 }))],
      '2026-07-21',
    );
    const far = result(
      'SPY',
      NOW,
      100,
      [strikeRow(100, leg({ gammaExposure: 2_000 }), leg({ gammaExposure: 1_000 }))],
      '2026-08-21',
    );
    await capture.persist(nearOlder, 'viewed', new Date(NOW.getTime() - 90_000));
    await capture.persist(near, 'viewed', new Date(NOW.getTime() - 30_000));
    await capture.persist(far, 'viewed', NOW);

    const termStructure = await query.getTermStructure(
      { symbol: 'SPY', maxSnapshotAgeMs: 10 * 60_000 },
      NOW,
    );

    expect(termStructure.expirations).toEqual(['2026-07-21', '2026-08-21']);
    const byExpiration = new Map(termStructure.cells.map((cell) => [cell.expiration, cell]));
    // The near expiration's LATEST row (gammaExposure 1000/500), not the older one (1/1).
    expect(byExpiration.get('2026-07-21')).toMatchObject({ callGex: 1_000, putGex: -500 });
    expect(byExpiration.get('2026-08-21')).toMatchObject({ callGex: 2_000, putGex: -1_000 });
  });

  it('excludes an expiration whose only snapshot is older than maxSnapshotAgeMs', async () => {
    const stale = result(
      'SPY',
      new Date(NOW.getTime() - 20 * 60_000),
      100,
      [strikeRow(100, leg(), leg())],
      '2026-07-21',
    );
    await capture.persist(stale, 'viewed', new Date(NOW.getTime() - 20 * 60_000));

    const termStructure = await query.getTermStructure(
      { symbol: 'SPY', maxSnapshotAgeMs: 5 * 60_000 },
      NOW,
    );

    expect(termStructure.expirations).toEqual([]);
    expect(termStructure.cells).toEqual([]);
  });

  it('is deterministic: repeated calls with identical stored inputs produce identical output', async () => {
    const row = result(
      'SPY',
      NOW,
      100,
      [strikeRow(100, leg({ gammaExposure: 1_000 }), leg({ gammaExposure: 500 }))],
      '2026-07-21',
    );
    await capture.persist(row, 'viewed', NOW);

    const params = { symbol: 'SPY', maxSnapshotAgeMs: 10 * 60_000 };
    const first = await query.getTermStructure(params, NOW);
    const second = await query.getTermStructure(params, NOW);
    expect(first).toEqual(second);
  });
});
