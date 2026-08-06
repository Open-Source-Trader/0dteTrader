import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { OptionsAnalyticsSnapshot } from '@0dtetrader/shared-types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryPrismaService } from '../../test/in-memory-prisma.service';
import type { OptionsAnalyticsSnapshotResult } from './options-analytics.service';
import { OptionsAnalyticsCaptureService } from './options-analytics.capture';

const NOW = new Date('2026-07-20T15:00:30.000Z');

function snapshot(
  symbol = 'SPY',
  expiration = '2026-07-20',
  observedAt = NOW,
): OptionsAnalyticsSnapshot {
  return {
    scope: {
      symbol,
      rootSymbol: symbol,
      settlementStyle: 'pm',
      expiration,
      observedAt: observedAt.toISOString(),
      settlementAt: '2026-07-20T20:00:00.000Z',
      spot: 100,
      forward: 100,
    },
    exposureUnit: '$ delta change per 1% underlying move',
    quality: {
      quoteAsOf: observedAt.toISOString(),
      greeksAsOf: observedAt.toISOString(),
      oiEffectiveDate: '2026-07-17',
      feedMode: 'realtime',
      coverage: { contractsTotal: 2, contractsIncluded: 2, ratio: 1 },
      status: 'complete',
      warnings: [],
      calculationVersion: 'options-analytics-v1',
      cacheStatus: 'fresh',
    },
    structure: {
      callGammaExposure: 10,
      putGammaExposure: 10,
      grossGammaExposure: 20,
      callDeltaNotional: 100,
      putDeltaNotional: -100,
      callWall: 100,
      putWall: 100,
      grossGammaConcentration: 1,
      maxOpenInterestStrike: 100,
    },
    scenarios: { callPutDealerProxy: null },
    impliedRange: null,
    strikes: [],
  };
}

function result(symbol = 'SPY', observedAt = NOW): OptionsAnalyticsSnapshotResult {
  const output = snapshot(symbol, '2026-07-20', observedAt);
  return {
    snapshot: output,
    scope: 'shared',
    input: {
      symbol,
      rootSymbol: symbol,
      settlementStyle: 'pm',
      expiration: output.scope.expiration,
      observedAt: output.scope.observedAt,
      settlementAt: output.scope.settlementAt,
      riskFreeRate: 0.04,
      quote: {
        symbol,
        spot: 100,
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

function config(values: Record<string, unknown> = {}): ConfigService {
  const defaults: Record<string, unknown> = {
    'optionsAnalytics.captureEnabled': true,
    'optionsAnalytics.coreSymbols': ['SPY', 'QQQ', 'IWM', 'SPX'],
    'tradier.token': 'token',
    ...values,
  };
  return { get: (key: string) => defaults[key] } as ConfigService;
}

function analyticsService() {
  return {
    calls: [] as string[],
    async getSnapshotResult(symbol: string) {
      this.calls.push(symbol);
      return result(symbol);
    },
  };
}

describe('OptionsAnalyticsCaptureService', () => {
  let prisma: InMemoryPrismaService;

  beforeEach(() => {
    prisma = new InMemoryPrismaService();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('persists a viewed minute once and treats a duplicate unique key as success', async () => {
    const service = new OptionsAnalyticsCaptureService(
      prisma as never,
      analyticsService() as never,
      config(),
    );

    const captured = result();
    captured.snapshot.impliedRange = {
      lower: 95,
      upper: 105,
      confidence: 0.68,
      label: 'model-implied 68% range',
      atmIv: 0.25,
      straddleLower: 96,
      straddleUpper: 104,
    };
    captured.snapshot.quality.calculationVersion = 'options-analytics-v2';
    await expect(service.persist(captured, 'viewed', NOW)).resolves.toBe(true);
    await expect(service.persist(captured, 'viewed', NOW)).resolves.toBe(true);

    expect(prisma.optionsAnalyticsSnapshots).toHaveLength(1);
    expect(prisma.optionsAnalyticsSnapshots[0]).toMatchObject({
      symbol: 'SPY',
      expiration: '2026-07-20',
      captureReason: 'viewed',
      resolutionMinutes: 1,
      calculationVersion: 'options-analytics-v2',
      atmIv: 0.25,
    });
    expect(prisma.optionsAnalyticsSnapshots[0].bucket.toISOString()).toBe(
      '2026-07-20T15:00:00.000Z',
    );
    expect(service.metrics.writes).toBe(1);
    expect(service.metrics.deduplications).toBe(1);
  });

  it('persists null ATM IV when no exact pair or interpolation bracket exists', async () => {
    const service = new OptionsAnalyticsCaptureService(
      prisma as never,
      analyticsService() as never,
      config(),
    );
    await expect(service.persist(result(), 'viewed', NOW)).resolves.toBe(true);
    expect(prisma.optionsAnalyticsSnapshots[0]).toMatchObject({ atmIv: null });
  });

  it('advances IV alerts once only for a newly created core snapshot', async () => {
    const alerts = { processCapture: jest.fn().mockResolvedValue([]) };
    const service = new OptionsAnalyticsCaptureService(
      prisma as never,
      analyticsService() as never,
      config(),
      alerts as never,
    );
    const captured = result('SPX');
    captured.snapshot.impliedRange = {
      lower: 95,
      upper: 105,
      confidence: 0.68,
      label: 'model-implied 68% range',
      atmIv: 0.25,
      straddleLower: 96,
      straddleUpper: 104,
    };

    await service.persist(captured, 'core', NOW);
    await service.persist(captured, 'core', NOW);
    await service.persist(captured, 'viewed', new Date(NOW.getTime() + 60_000));

    expect(alerts.processCapture).toHaveBeenCalledTimes(1);
    expect(alerts.processCapture).toHaveBeenCalledWith({
      symbol: 'SPX',
      timestamp: NOW,
      atmIv: 0.25,
    });
  });

  it('advances the detector when a viewed snapshot claimed the core minute first', async () => {
    const alerts = { processCapture: jest.fn().mockResolvedValue([]) };
    const service = new OptionsAnalyticsCaptureService(
      prisma as never,
      analyticsService() as never,
      config(),
      alerts as never,
    );
    const captured = result('SPX');
    captured.snapshot.impliedRange = {
      lower: 95,
      upper: 105,
      confidence: 0.68,
      label: 'model-implied 68% range',
      atmIv: 0.25,
      straddleLower: 96,
      straddleUpper: 104,
    };

    await service.persist(captured, 'viewed', NOW);
    await expect(service.persist(captured, 'core', NOW)).resolves.toBe(true);

    expect(prisma.optionsAnalyticsSnapshots).toHaveLength(1);
    expect(alerts.processCapture).toHaveBeenCalledTimes(1);
    expect(alerts.processCapture).toHaveBeenCalledWith({
      symbol: 'SPX',
      timestamp: NOW,
      atmIv: 0.25,
    });
  });

  it('keeps a core capture pending until detector processing succeeds', async () => {
    const alerts = {
      processCapture: jest
        .fn()
        .mockRejectedValueOnce(new Error('detector database unavailable'))
        .mockResolvedValueOnce([]),
    };
    const service = new OptionsAnalyticsCaptureService(
      prisma as never,
      analyticsService() as never,
      config(),
      alerts as never,
    );
    const captured = result('SPX');

    await expect(service.persist(captured, 'core', NOW)).resolves.toBe(false);
    expect(prisma.optionsAnalyticsSnapshots[0]).toMatchObject({
      captureReason: 'core',
      detectorProcessedAt: null,
    });

    await expect(service.persist(captured, 'core', NOW)).resolves.toBe(true);
    expect(prisma.optionsAnalyticsSnapshots[0].detectorProcessedAt).toBeInstanceOf(Date);
    expect(alerts.processCapture).toHaveBeenCalledTimes(2);
  });

  it('drains a detector-pending core row after restart before capturing the current minute', async () => {
    const failingAlerts = {
      processCapture: jest.fn().mockRejectedValue(new Error('detector database unavailable')),
    };
    const captured = result('SPX');
    const first = new OptionsAnalyticsCaptureService(
      prisma as never,
      analyticsService() as never,
      config({ 'optionsAnalytics.coreSymbols': ['SPX'] }),
      failingAlerts as never,
    );
    await expect(first.persist(captured, 'core', NOW)).resolves.toBe(false);

    const recoveredAlerts = { processCapture: jest.fn().mockResolvedValue([]) };
    const restarted = new OptionsAnalyticsCaptureService(
      prisma as never,
      analyticsService() as never,
      config({ 'optionsAnalytics.coreSymbols': ['SPX'] }),
      recoveredAlerts as never,
    );
    jest.spyOn(restarted, 'maintain').mockResolvedValue(true);

    await restarted.runScheduledTick(new Date(NOW.getTime() + 60_000));

    expect(recoveredAlerts.processCapture).toHaveBeenCalledTimes(2);
    expect(prisma.optionsAnalyticsSnapshots).toHaveLength(2);
    expect(
      prisma.optionsAnalyticsSnapshots.every(
        (row) => row.captureReason === 'core' && row.detectorProcessedAt instanceof Date,
      ),
    ).toBe(true);
    expect(restarted.metrics.detectorPendingRecovered).toBe(1);
    expect(restarted.metrics.detectorPendingDeferred).toBe(0);
  });

  it('does not let more than 1,000 migration-backfilled history rows block fresh capture', async () => {
    const migration = readFileSync(
      join(
        __dirname,
        '../../prisma/migrations/20260805220000_options_analytics_atm_iv/migration.sql',
      ),
      'utf8',
    );
    const backfillPosition = migration.indexOf('UPDATE "options_analytics_snapshots"');
    const pendingIndexPosition = migration.indexOf(
      'CREATE INDEX "options_analytics_detector_pending_idx"',
    );
    expect(backfillPosition).toBeGreaterThan(-1);
    expect(pendingIndexPosition).toBeGreaterThan(backfillPosition);
    expect(migration).toContain('SET "detectorProcessedAt" = "createdAt"');

    const migratedAt = new Date('2026-08-05T12:00:00.000Z');
    for (let index = 0; index < 1_001; index += 1) {
      prisma.optionsAnalyticsSnapshots.push({
        id: `historical-${index}`,
        symbol: 'SPX',
        expiration: '2026-07-20',
        observedAt: new Date(migratedAt.getTime() - index * 60_000),
        settlementAt: migratedAt,
        bucket: new Date(migratedAt.getTime() - index * 60_000),
        captureReason: 'core',
        resolutionMinutes: 1,
        calculationVersion: 'options-analytics-v1',
        atmIv: null,
        detectorProcessedAt: migratedAt,
        input: {},
        output: {},
        quality: {},
        createdAt: migratedAt,
      });
    }
    const analytics = analyticsService();
    const service = new OptionsAnalyticsCaptureService(
      prisma as never,
      analytics as never,
      config({ 'optionsAnalytics.coreSymbols': ['SPX'] }),
      { processCapture: jest.fn().mockResolvedValue([]) } as never,
    );
    jest.spyOn(service, 'maintain').mockResolvedValue(true);

    await service.runScheduledTick(NOW);

    expect(analytics.calls).toEqual(['SPX']);
    expect(prisma.optionsAnalyticsSnapshots).toHaveLength(1_002);
    expect(service.metrics).toMatchObject({
      coreSuccess: 1,
      detectorPendingRecovered: 0,
      detectorPendingDeferred: 0,
    });
  });

  it('bounds a real pending backlog and reports recovered and deferred work directly', async () => {
    for (let index = 0; index < 1_001; index += 1) {
      prisma.optionsAnalyticsSnapshots.push({
        id: `pending-${index}`,
        symbol: 'SPY',
        observedAt: new Date(NOW.getTime() - (index + 1) * 60_000),
        bucket: new Date(NOW.getTime() - (index + 1) * 60_000),
        captureReason: 'core',
        resolutionMinutes: 1,
        detectorProcessedAt: null,
      });
    }
    const analytics = analyticsService();
    const service = new OptionsAnalyticsCaptureService(
      prisma as never,
      analytics as never,
      config({ 'optionsAnalytics.coreSymbols': ['SPX'] }),
    );

    await service.runScheduledTick(NOW);

    expect(analytics.calls).toEqual([]);
    expect(service.metrics).toMatchObject({
      coreFailure: 1,
      detectorPendingRecovered: 1_000,
      detectorPendingDeferred: 1,
    });
    expect(
      prisma.optionsAnalyticsSnapshots.filter((row) => row.detectorProcessedAt === null),
    ).toHaveLength(1);
  });

  it('uses capture time for the minute bucket while preserving source observedAt', async () => {
    const service = new OptionsAnalyticsCaptureService(
      prisma as never,
      analyticsService() as never,
      config(),
    );
    const staleResult = result('SPY', NOW);
    const firstCapture = new Date('2026-07-20T15:05:45.000Z');
    const laterCapture = new Date('2026-07-20T15:06:01.000Z');

    await expect(service.persist(staleResult, 'viewed', firstCapture)).resolves.toBe(true);
    await expect(service.persist(staleResult, 'viewed', firstCapture)).resolves.toBe(true);
    await expect(service.persist(staleResult, 'viewed', laterCapture)).resolves.toBe(true);

    expect(prisma.optionsAnalyticsSnapshots).toHaveLength(2);
    expect(prisma.optionsAnalyticsSnapshots.map((row) => row.bucket.toISOString())).toEqual([
      '2026-07-20T15:05:00.000Z',
      '2026-07-20T15:06:00.000Z',
    ]);
    expect(
      prisma.optionsAnalyticsSnapshots.every(
        (row) => row.observedAt.toISOString() === NOW.toISOString(),
      ),
    ).toBe(true);
  });

  it('captures all four core symbols once per open-session tick and skips closed sessions', async () => {
    const analytics = analyticsService();
    const service = new OptionsAnalyticsCaptureService(
      prisma as never,
      analytics as never,
      config(),
    );
    jest.spyOn(service, 'maintain').mockResolvedValue(true);

    await service.runScheduledTick(new Date('2026-07-20T15:00:00.000Z'));
    await service.runScheduledTick(new Date('2026-07-20T21:00:00.000Z'));

    expect(analytics.calls).toEqual(['SPY', 'QQQ', 'IWM', 'SPX']);
    expect(prisma.optionsAnalyticsSnapshots).toHaveLength(4);
    expect(prisma.optionsAnalyticsSnapshots.every((row) => row.captureReason === 'core')).toBe(
      true,
    );
    expect(service.metrics.coreSuccess).toBe(4);
    expect(service.metrics.coreFailure).toBe(0);
  });

  it('starts all core symbols concurrently so one slow symbol does not serialize the rest', async () => {
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const calls: string[] = [];
    const analytics = {
      async getSnapshotResult(symbol: string) {
        calls.push(symbol);
        if (symbol === 'SPY') await slow;
        return result(symbol);
      },
    };
    const service = new OptionsAnalyticsCaptureService(
      prisma as never,
      analytics as never,
      config(),
    );
    jest.spyOn(service, 'maintain').mockResolvedValue(true);

    const tick = service.runScheduledTick(new Date('2026-07-20T15:00:00.000Z'));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(calls).toEqual(['SPY', 'QQQ', 'IWM', 'SPX']);
    releaseSlow();
    await tick;
    expect(service.metrics.coreSuccess).toBe(4);
  });

  it('captures the open-session minute before waiting on daily maintenance', async () => {
    let releaseMaintenance!: () => void;
    const maintenanceGate = new Promise<void>((resolve) => {
      releaseMaintenance = resolve;
    });
    const events: string[] = [];
    const analytics = {
      async getSnapshotResult(symbol: string) {
        events.push(`capture:${symbol}`);
        return result(symbol);
      },
    };
    const service = new OptionsAnalyticsCaptureService(
      prisma as never,
      analytics as never,
      config({ 'optionsAnalytics.coreSymbols': ['SPY'] }),
    );
    jest.spyOn(service, 'maintain').mockImplementation(async () => {
      events.push('maintenance');
      await maintenanceGate;
      return true;
    });

    const tick = service.runScheduledTick(new Date('2026-07-20T15:00:00.000Z'));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(events).toEqual(['capture:SPY', 'maintenance']);
    expect(prisma.optionsAnalyticsSnapshots).toHaveLength(1);
    releaseMaintenance();
    await tick;
  });

  it('reports scheduled database write failures as core failures', async () => {
    const service = new OptionsAnalyticsCaptureService(
      prisma as never,
      analyticsService() as never,
      config({ 'optionsAnalytics.coreSymbols': ['SPY'] }),
    );
    jest.spyOn(service, 'maintain').mockResolvedValue(true);
    jest
      .spyOn(prisma.optionsAnalyticsSnapshotRecord, 'create')
      .mockRejectedValue(new Error('database write failed'));

    await service.runScheduledTick(new Date('2026-07-20T15:00:00.000Z'));

    expect(service.metrics.coreSuccess).toBe(0);
    expect(service.metrics.coreFailure).toBe(1);
    expect(service.metrics.failures).toBe(1);
  });

  it('retries maintenance on the next tick when the first same-day attempt fails', async () => {
    const service = new OptionsAnalyticsCaptureService(
      prisma as never,
      analyticsService() as never,
      config({ 'optionsAnalytics.coreSymbols': [] }),
    );
    const observedAt = new Date('2026-06-19T15:02:00.000Z');
    const value = result('SPY', observedAt);
    await prisma.optionsAnalyticsSnapshotRecord.create({
      data: {
        symbol: 'SPY',
        expiration: '2026-07-20',
        observedAt,
        settlementAt: new Date(value.snapshot.scope.settlementAt),
        bucket: observedAt,
        captureReason: 'core',
        resolutionMinutes: 1,
        calculationVersion: 'options-analytics-v1',
        input: value.input,
        output: value.snapshot,
        quality: value.snapshot.quality,
      },
    });
    const originalCreate = prisma.optionsAnalyticsSnapshotRecord.create;
    let compactionAvailable = false;
    const create = jest
      .spyOn(prisma.optionsAnalyticsSnapshotRecord, 'create')
      .mockImplementation(async (args) => {
        if (args.data.resolutionMinutes === 5 && !compactionAvailable) {
          throw new Error('temporary compaction write failure');
        }
        return originalCreate(args);
      });

    await service.runScheduledTick(new Date('2026-07-20T15:00:00.000Z'));
    expect(prisma.optionsAnalyticsSnapshots).toHaveLength(1);
    expect(prisma.optionsAnalyticsSnapshots[0].resolutionMinutes).toBe(1);

    compactionAvailable = true;
    await service.runScheduledTick(new Date('2026-07-20T15:01:00.000Z'));

    expect(create.mock.calls.filter(([args]) => args.data.resolutionMinutes === 5)).toHaveLength(2);
    expect(prisma.optionsAnalyticsSnapshots).toHaveLength(1);
    expect(prisma.optionsAnalyticsSnapshots[0].resolutionMinutes).toBe(5);
    expect(service.metrics.maintenanceFailure).toBe(1);
    expect(service.metrics.maintenanceSuccess).toBe(1);
  });

  it('uses a database lease so two scheduler instances make one set of core provider calls', async () => {
    const firstAnalytics = analyticsService();
    const secondAnalytics = analyticsService();
    const first = new OptionsAnalyticsCaptureService(
      prisma as never,
      firstAnalytics as never,
      config(),
    );
    const second = new OptionsAnalyticsCaptureService(
      prisma as never,
      secondAnalytics as never,
      config(),
    );
    jest.spyOn(first, 'maintain').mockResolvedValue(true);
    jest.spyOn(second, 'maintain').mockResolvedValue(true);

    await first.runScheduledTick(new Date('2026-07-20T15:00:00.000Z'));
    await second.runScheduledTick(new Date('2026-07-20T15:00:00.000Z'));

    expect(firstAnalytics.calls).toEqual(['SPY', 'QQQ', 'IWM', 'SPX']);
    expect(secondAnalytics.calls).toEqual([]);
  });

  it('uses a cross-instance daily lease while the next minute core capture continues', async () => {
    let releaseMaintenance!: () => void;
    const maintenanceGate = new Promise<void>((resolve) => {
      releaseMaintenance = resolve;
    });
    const first = new OptionsAnalyticsCaptureService(
      prisma as never,
      analyticsService() as never,
      config({ 'optionsAnalytics.coreSymbols': [] }),
    );
    const secondAnalytics = analyticsService();
    const second = new OptionsAnalyticsCaptureService(
      prisma as never,
      secondAnalytics as never,
      config({ 'optionsAnalytics.coreSymbols': ['SPY'] }),
    );
    const firstMaintenance = jest.spyOn(first, 'maintain').mockImplementation(async () => {
      await maintenanceGate;
      return true;
    });
    const secondMaintenance = jest.spyOn(second, 'maintain').mockResolvedValue(true);

    const firstTick = first.runScheduledTick(new Date('2026-07-20T15:00:00.000Z'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(firstMaintenance).toHaveBeenCalledTimes(1);
    const maintenanceLease = prisma.scheduledJobLeases.find((lease) =>
      lease.name.startsWith('options-analytics-daily-maintenance:'),
    );
    expect(maintenanceLease?.expiresAt).toEqual(new Date('2026-07-22T03:00:00.000Z'));

    await second.runScheduledTick(new Date('2026-07-20T15:01:00.000Z'));

    expect(secondAnalytics.calls).toEqual(['SPY']);
    expect(secondMaintenance).not.toHaveBeenCalled();
    releaseMaintenance();
    await firstTick;
  });

  it('does not start the scheduler when capture is disabled or the token is absent', () => {
    const disabled = new OptionsAnalyticsCaptureService(
      prisma as never,
      analyticsService() as never,
      config({ 'optionsAnalytics.captureEnabled': false }),
    );
    disabled.onModuleInit();
    expect(disabled.schedulerActive).toBe(false);

    const noToken = new OptionsAnalyticsCaptureService(
      prisma as never,
      analyticsService() as never,
      config({ 'tradier.token': '' }),
    );
    noToken.onModuleInit();
    expect(noToken.schedulerActive).toBe(false);
  });

  it('compacts representative five-minute rows before deleting 30-day minute detail', async () => {
    const service = new OptionsAnalyticsCaptureService(
      prisma as never,
      analyticsService() as never,
      config(),
    );
    const oldBucket = new Date('2026-06-19T15:02:00.000Z');
    const laterPartial = new Date('2026-06-19T15:04:00.000Z');
    const retainedMinute = new Date('2026-07-01T15:00:00.000Z');
    const expiredCompact = new Date('2025-07-19T15:00:00.000Z');
    for (const [observedAt, resolutionMinutes] of [
      [oldBucket, 1],
      [laterPartial, 1],
      [retainedMinute, 1],
      [expiredCompact, 5],
    ] as const) {
      const value = result('SPY', observedAt);
      if (observedAt === laterPartial) {
        value.snapshot.quality.status = 'partial';
        value.snapshot.quality.coverage = {
          contractsTotal: 2,
          contractsIncluded: 1,
          ratio: 0.5,
        };
      }
      await prisma.optionsAnalyticsSnapshotRecord.create({
        data: {
          symbol: 'SPY',
          expiration: '2026-07-20',
          observedAt,
          settlementAt: new Date(value.snapshot.scope.settlementAt),
          bucket: observedAt,
          captureReason: 'core',
          resolutionMinutes,
          calculationVersion: 'options-analytics-v1',
          input: value.input,
          output: value.snapshot,
          quality: value.snapshot.quality,
        },
      });
    }

    await expect(service.maintain(new Date('2026-07-20T16:00:00.000Z'))).resolves.toBe(true);

    const minuteRows = prisma.optionsAnalyticsSnapshots.filter(
      (row) => row.resolutionMinutes === 1,
    );
    const compactRows = prisma.optionsAnalyticsSnapshots.filter(
      (row) => row.resolutionMinutes === 5,
    );
    expect(minuteRows.map((row) => row.bucket.toISOString())).toEqual([
      retainedMinute.toISOString(),
    ]);
    expect(compactRows).toHaveLength(1);
    expect(compactRows[0].bucket.toISOString()).toBe('2026-06-19T15:00:00.000Z');
    expect(compactRows[0].observedAt.toISOString()).toBe(oldBucket.toISOString());
    expect(service.metrics.compacted).toBe(1);
    expect(service.metrics.deletedMinute).toBe(2);
    expect(service.metrics.deletedCompact).toBe(1);
    expect(service.metrics.maintenanceSuccess).toBe(1);
    expect(service.metrics.maintenanceFailure).toBe(0);
  });

  it('retains minute sources when compact persistence fails', async () => {
    const service = new OptionsAnalyticsCaptureService(
      prisma as never,
      analyticsService() as never,
      config(),
    );
    const value = result('SPY', new Date('2026-06-19T15:02:00.000Z'));
    await prisma.optionsAnalyticsSnapshotRecord.create({
      data: {
        symbol: 'SPY',
        expiration: '2026-07-20',
        observedAt: new Date(value.snapshot.scope.observedAt),
        settlementAt: new Date(value.snapshot.scope.settlementAt),
        bucket: new Date(value.snapshot.scope.observedAt),
        captureReason: 'core',
        resolutionMinutes: 1,
        calculationVersion: 'options-analytics-v1',
        input: value.input,
        output: value.snapshot,
        quality: value.snapshot.quality,
      },
    });
    const originalCreate = prisma.optionsAnalyticsSnapshotRecord.create;
    jest.spyOn(prisma.optionsAnalyticsSnapshotRecord, 'create').mockImplementation(async (args) => {
      if (args.data.resolutionMinutes === 5) throw new Error('database down');
      return originalCreate(args);
    });

    await expect(service.maintain(new Date('2026-07-20T16:00:00.000Z'))).resolves.toBe(false);

    expect(prisma.optionsAnalyticsSnapshots).toHaveLength(1);
    expect(prisma.optionsAnalyticsSnapshots[0].resolutionMinutes).toBe(1);
    expect(service.metrics.deletedMinute).toBe(0);
    expect(service.metrics.maintenanceSuccess).toBe(0);
    expect(service.metrics.maintenanceFailure).toBe(1);
  });

  it('reports a thrown maintenance query as an observable maintenance failure', async () => {
    const service = new OptionsAnalyticsCaptureService(
      prisma as never,
      analyticsService() as never,
      config(),
    );
    jest
      .spyOn(prisma.optionsAnalyticsSnapshotRecord, 'findMany')
      .mockRejectedValueOnce(new Error('maintenance query failed'));

    await expect(service.maintain(new Date('2026-07-20T16:00:00.000Z'))).resolves.toBe(false);

    expect(service.metrics.maintenanceSuccess).toBe(0);
    expect(service.metrics.maintenanceFailure).toBe(1);
    expect(service.metrics.failures).toBe(1);
  });

  it('extends a 1000-row page boundary and chooses the best complete representative', async () => {
    const service = new OptionsAnalyticsCaptureService(
      prisma as never,
      analyticsService() as never,
      config(),
    );
    const fillerStart = new Date('2026-05-01T00:00:00.000Z').getTime();
    for (let index = 0; index < 999; index += 1) {
      const observedAt = new Date(fillerStart + index * 60_000);
      const value = result('FILLER', observedAt);
      prisma.optionsAnalyticsSnapshots.push({
        id: `filler-${index}`,
        createdAt: observedAt,
        symbol: 'FILLER',
        expiration: '2026-07-20',
        observedAt,
        settlementAt: new Date(value.snapshot.scope.settlementAt),
        bucket: observedAt,
        captureReason: 'core',
        resolutionMinutes: 1,
        calculationVersion: 'options-analytics-v1',
        input: value.input,
        output: value.snapshot,
        quality: value.snapshot.quality,
      });
    }
    const partialAt = new Date('2026-06-19T15:02:00.000Z');
    const completeAt = new Date('2026-06-19T15:04:00.000Z');
    for (const [observedAt, complete] of [
      [partialAt, false],
      [completeAt, true],
    ] as const) {
      const value = result('BOUNDARY', observedAt);
      if (!complete) {
        value.snapshot.quality.status = 'partial';
        value.snapshot.quality.coverage = {
          contractsTotal: 2,
          contractsIncluded: 1,
          ratio: 0.5,
        };
      }
      prisma.optionsAnalyticsSnapshots.push({
        id: `boundary-${complete ? 'complete' : 'partial'}`,
        createdAt: observedAt,
        symbol: 'BOUNDARY',
        expiration: '2026-07-20',
        observedAt,
        settlementAt: new Date(value.snapshot.scope.settlementAt),
        bucket: observedAt,
        captureReason: 'core',
        resolutionMinutes: 1,
        calculationVersion: 'options-analytics-v1',
        input: value.input,
        output: value.snapshot,
        quality: value.snapshot.quality,
      });
    }

    await expect(service.maintain(new Date('2026-07-20T16:00:00.000Z'))).resolves.toBe(true);

    const boundaryRows = prisma.optionsAnalyticsSnapshots.filter(
      (row) => row.symbol === 'BOUNDARY',
    );
    expect(boundaryRows).toHaveLength(1);
    expect(boundaryRows[0]).toMatchObject({ resolutionMinutes: 5 });
    expect(boundaryRows[0].bucket.toISOString()).toBe('2026-06-19T15:00:00.000Z');
    expect(boundaryRows[0].observedAt.toISOString()).toBe(completeAt.toISOString());
    expect(boundaryRows[0].quality.status).toBe('complete');
  });
});
