import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type OptionsAnalyticsSnapshotRecord } from '@prisma/client';
import { isRegularMarketSessionOpen } from '../broker/expiration-calendar';
import { PrismaService } from '../prisma/prisma.service';
import {
  OptionsAnalyticsService,
  type OptionsAnalyticsSnapshotResult,
} from './options-analytics.service';

type CaptureReason = 'core' | 'viewed';

type CreateRecordStatus = 'created' | 'duplicate' | 'failed';

const MAINTENANCE_LEASE_MS = 36 * 60 * 60_000;

export interface OptionsAnalyticsCaptureMetrics {
  writes: number;
  deduplications: number;
  failures: number;
  compacted: number;
  deletedMinute: number;
  deletedCompact: number;
  coreSuccess: number;
  coreFailure: number;
  maintenanceSuccess: number;
  maintenanceFailure: number;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function floorBucket(date: Date, resolutionMinutes: 1 | 5): Date {
  const bucketMs = resolutionMinutes * 60_000;
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs);
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function newYorkDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

@Injectable()
export class OptionsAnalyticsCaptureService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OptionsAnalyticsCaptureService.name);
  private boundaryTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private captureRunning = false;
  private maintenanceRunning = false;
  private lastMaintenanceDay: string | null = null;
  private readonly leaseOwnerId = randomUUID();

  readonly metrics: OptionsAnalyticsCaptureMetrics = {
    writes: 0,
    deduplications: 0,
    failures: 0,
    compacted: 0,
    deletedMinute: 0,
    deletedCompact: 0,
    coreSuccess: 0,
    coreFailure: 0,
    maintenanceSuccess: 0,
    maintenanceFailure: 0,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: OptionsAnalyticsService,
    private readonly config: ConfigService,
  ) {}

  get schedulerActive(): boolean {
    return this.boundaryTimer !== null || this.intervalTimer !== null;
  }

  onModuleInit(): void {
    if (this.config.get<boolean>('optionsAnalytics.captureEnabled') !== true) {
      this.logger.log(JSON.stringify({ event: 'options_analytics_capture_disabled' }));
      return;
    }
    if (!(this.config.get<string>('tradier.token') ?? '').trim()) {
      this.logger.warn(
        JSON.stringify({
          event: 'options_analytics_capture_noop',
          reason: 'tradier_token_missing',
        }),
      );
      return;
    }

    const delay = Math.max(1, 60_000 - (Date.now() % 60_000));
    this.boundaryTimer = setTimeout(() => {
      this.boundaryTimer = null;
      void this.runScheduledTick(new Date());
      this.intervalTimer = setInterval(() => {
        void this.runScheduledTick(new Date());
      }, 60_000);
      this.intervalTimer.unref?.();
    }, delay);
    this.boundaryTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.boundaryTimer) clearTimeout(this.boundaryTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.boundaryTimer = null;
    this.intervalTimer = null;
  }

  async persist(
    result: OptionsAnalyticsSnapshotResult,
    captureReason: CaptureReason,
    capturedAt = new Date(),
  ): Promise<boolean> {
    const observedAt = new Date(result.snapshot.scope.observedAt);
    const data: Prisma.OptionsAnalyticsSnapshotRecordCreateInput = {
      symbol: result.snapshot.scope.symbol,
      expiration: result.snapshot.scope.expiration,
      observedAt,
      settlementAt: new Date(result.snapshot.scope.settlementAt),
      bucket: floorBucket(capturedAt, 1),
      captureReason,
      resolutionMinutes: 1,
      calculationVersion: result.snapshot.quality.calculationVersion,
      input: inputJson(result.input),
      output: inputJson(result.snapshot),
      quality: inputJson(result.snapshot.quality),
    };
    return (await this.createRecord(data, true)) !== 'failed';
  }

  async runScheduledTick(now: Date): Promise<void> {
    if (this.captureRunning) {
      this.logger.warn(
        JSON.stringify({
          event: 'options_analytics_capture_skipped',
          reason: 'overlap',
        }),
      );
      return;
    }
    this.captureRunning = true;
    let ownsLease = false;
    try {
      ownsLease = await this.acquireLease(
        'options-analytics-minute-capture',
        now,
        55_000,
        'options_analytics_scheduler_lease_failed',
      );
      if (!ownsLease) return;
      if (isRegularMarketSessionOpen(now)) {
        const configured = this.config.get<unknown>('optionsAnalytics.coreSymbols');
        const coreSymbols = Array.isArray(configured)
          ? configured.filter(
              (symbol): symbol is string => typeof symbol === 'string' && symbol !== '',
            )
          : ['SPY', 'QQQ', 'IWM', 'SPX'];
        await Promise.all(
          [...new Set(coreSymbols)].map(async (symbol) => {
            try {
              const result = await this.analytics.getSnapshotResult(symbol);
              const stored = await this.persist(result, 'core', now);
              if (stored) {
                this.metrics.coreSuccess += 1;
              } else {
                this.metrics.coreFailure += 1;
              }
            } catch (error) {
              this.metrics.coreFailure += 1;
              this.logger.error(
                JSON.stringify({
                  event: 'options_analytics_core_capture_failed',
                  symbol,
                  message: error instanceof Error ? error.message : String(error),
                }),
              );
            }
          }),
        );
      }
    } finally {
      this.captureRunning = false;
    }
    if (!ownsLease) return;
    const day = newYorkDate(now);
    if (this.lastMaintenanceDay !== day) {
      const maintenanceLeaseName = `options-analytics-daily-maintenance:${day}`;
      const ownsMaintenanceLease = await this.acquireLease(
        maintenanceLeaseName,
        now,
        MAINTENANCE_LEASE_MS,
        'options_analytics_maintenance_lease_failed',
      );
      if (ownsMaintenanceLease) {
        const maintained = await this.maintain(now);
        const leaseExpiry = maintained
          ? new Date(now.getTime() + MAINTENANCE_LEASE_MS)
          : new Date(now.getTime() - 1);
        const finalized = await this.updateOwnedLeaseExpiry(maintenanceLeaseName, leaseExpiry);
        if (maintained && finalized) this.lastMaintenanceDay = day;
      }
    }
  }

  async maintain(now = new Date()): Promise<boolean> {
    if (this.maintenanceRunning) return false;
    this.maintenanceRunning = true;
    const before = { ...this.metrics };
    let hadFailure = false;
    try {
      const minuteCutoff = new Date(now.getTime() - 30 * 86_400_000);
      const compactCutoff = new Date(now.getTime() - 365 * 86_400_000);
      for (;;) {
        let sourceRows = await this.delegate.findMany({
          where: { resolutionMinutes: 1, bucket: { lt: minuteCutoff } },
          orderBy: { bucket: 'asc' },
          take: 1_000,
        });
        if (sourceRows.length === 0) break;
        if (sourceRows.length === 1_000) {
          // Complete the final five-minute time boundary so a group cannot be
          // split across pages and compacted with an early representative.
          const boundary = floorBucket(sourceRows[sourceRows.length - 1].bucket, 5);
          const boundaryEnd = new Date(
            Math.min(boundary.getTime() + 5 * 60_000, minuteCutoff.getTime()),
          );
          const boundaryRows = await this.delegate.findMany({
            where: {
              resolutionMinutes: 1,
              bucket: { gte: boundary, lt: boundaryEnd },
            },
            orderBy: { bucket: 'asc' },
          });
          const merged = new Map(sourceRows.map((row) => [row.id, row]));
          boundaryRows.forEach((row) => merged.set(row.id, row));
          sourceRows = [...merged.values()].sort(
            (left, right) => left.bucket.getTime() - right.bucket.getTime(),
          );
        }
        const representatives = new Map<string, OptionsAnalyticsSnapshotRecord>();
        for (const row of sourceRows) {
          const key = this.compactionKey(row);
          const current = representatives.get(key);
          if (!current || this.isBetterRepresentative(row, current)) {
            representatives.set(key, row);
          }
        }
        const successfulGroups = new Set<string>();
        for (const [key, row] of representatives) {
          const status = await this.createRecord(
            {
              symbol: row.symbol,
              expiration: row.expiration,
              observedAt: row.observedAt,
              settlementAt: row.settlementAt,
              bucket: floorBucket(row.bucket, 5),
              captureReason: row.captureReason,
              resolutionMinutes: 5,
              calculationVersion: row.calculationVersion,
              input: inputJson(row.input),
              output: inputJson(row.output),
              quality: inputJson(row.quality),
            },
            false,
          );
          if (status === 'created') this.metrics.compacted += 1;
          if (status !== 'failed') successfulGroups.add(key);
          else hadFailure = true;
        }
        const deletableIds = sourceRows
          .filter((row) => successfulGroups.has(this.compactionKey(row)))
          .map((row) => row.id);
        if (deletableIds.length === 0) break;
        const deleted = await this.delegate.deleteMany({
          where: { id: { in: deletableIds } },
        });
        this.metrics.deletedMinute += deleted.count;
        if (hadFailure) break;
      }
      const deletedCompact = await this.delegate.deleteMany({
        where: { resolutionMinutes: 5, bucket: { lt: compactCutoff } },
      });
      this.metrics.deletedCompact += deletedCompact.count;
      if (hadFailure) {
        this.metrics.maintenanceFailure += 1;
        this.logger.warn(
          JSON.stringify({
            event: 'options_analytics_maintenance_incomplete',
            reason: 'one_or_more_compaction_writes_failed',
            compacted: this.metrics.compacted - before.compacted,
            deletedMinute: this.metrics.deletedMinute - before.deletedMinute,
            deletedCompact: this.metrics.deletedCompact - before.deletedCompact,
          }),
        );
      } else {
        this.metrics.maintenanceSuccess += 1;
        this.logger.log(
          JSON.stringify({
            event: 'options_analytics_maintenance_complete',
            compacted: this.metrics.compacted - before.compacted,
            deletedMinute: this.metrics.deletedMinute - before.deletedMinute,
            deletedCompact: this.metrics.deletedCompact - before.deletedCompact,
          }),
        );
      }
      return !hadFailure;
    } catch (error) {
      this.metrics.failures += 1;
      this.metrics.maintenanceFailure += 1;
      this.logger.error(
        JSON.stringify({
          event: 'options_analytics_maintenance_failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return false;
    } finally {
      this.maintenanceRunning = false;
    }
  }

  private async createRecord(
    data: Prisma.OptionsAnalyticsSnapshotRecordCreateInput,
    countCaptureWrite: boolean,
  ): Promise<CreateRecordStatus> {
    try {
      await this.delegate.create({ data });
      if (countCaptureWrite) this.metrics.writes += 1;
      this.logger.log(
        JSON.stringify({
          event: 'options_analytics_snapshot_stored',
          symbol: data.symbol,
          expiration: data.expiration,
          captureReason: data.captureReason,
          resolutionMinutes: data.resolutionMinutes,
          bucket: new Date(data.bucket).toISOString(),
        }),
      );
      return 'created';
    } catch (error) {
      if (isUniqueViolation(error)) {
        if (countCaptureWrite) this.metrics.deduplications += 1;
        return 'duplicate';
      }
      this.metrics.failures += 1;
      this.logger.error(
        JSON.stringify({
          event: 'options_analytics_snapshot_store_failed',
          symbol: data.symbol,
          expiration: data.expiration,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return 'failed';
    }
  }

  private compactionKey(row: OptionsAnalyticsSnapshotRecord): string {
    return [
      row.symbol,
      row.expiration,
      floorBucket(row.bucket, 5).toISOString(),
      row.calculationVersion,
    ].join(':');
  }

  private isBetterRepresentative(
    candidate: OptionsAnalyticsSnapshotRecord,
    current: OptionsAnalyticsSnapshotRecord,
  ): boolean {
    const quality = (row: OptionsAnalyticsSnapshotRecord): { complete: number; ratio: number } => {
      const value =
        row.quality !== null && typeof row.quality === 'object'
          ? (row.quality as Record<string, unknown>)
          : {};
      const coverage =
        value['coverage'] !== null && typeof value['coverage'] === 'object'
          ? (value['coverage'] as Record<string, unknown>)
          : {};
      const ratio = coverage['ratio'];
      return {
        complete: value['status'] === 'complete' ? 1 : 0,
        ratio: typeof ratio === 'number' && Number.isFinite(ratio) ? ratio : 0,
      };
    };
    const candidateQuality = quality(candidate);
    const currentQuality = quality(current);
    if (candidateQuality.complete !== currentQuality.complete) {
      return candidateQuality.complete > currentQuality.complete;
    }
    if (candidateQuality.ratio !== currentQuality.ratio) {
      return candidateQuality.ratio > currentQuality.ratio;
    }
    return candidate.observedAt > current.observedAt;
  }

  private async acquireLease(
    name: string,
    now: Date,
    durationMs: number,
    failureEvent: string,
  ): Promise<boolean> {
    const expiresAt = new Date(now.getTime() + durationMs);
    try {
      const updated = await this.prisma.scheduledJobLease.updateMany({
        where: { name, expiresAt: { lt: now } },
        data: { ownerId: this.leaseOwnerId, expiresAt },
      });
      if (updated.count === 1) return true;
      try {
        await this.prisma.scheduledJobLease.create({
          data: { name, ownerId: this.leaseOwnerId, expiresAt },
        });
        return true;
      } catch (error) {
        if (isUniqueViolation(error)) return false;
        throw error;
      }
    } catch (error) {
      this.metrics.failures += 1;
      this.logger.error(
        JSON.stringify({
          event: failureEvent,
          lease: name,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return false;
    }
  }

  private async updateOwnedLeaseExpiry(name: string, expiresAt: Date): Promise<boolean> {
    try {
      const updated = await this.prisma.scheduledJobLease.updateMany({
        where: { name, ownerId: this.leaseOwnerId },
        data: { expiresAt },
      });
      return updated.count === 1;
    } catch (error) {
      this.metrics.failures += 1;
      this.logger.error(
        JSON.stringify({
          event: 'options_analytics_maintenance_lease_finalize_failed',
          lease: name,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return false;
    }
  }

  private get delegate() {
    return this.prisma.optionsAnalyticsSnapshotRecord;
  }
}
