import type {
  IVAlert,
  IVAlertConfiguration,
  IVAlertConfigurationState,
  IVAlertDirection,
  IVAlertSymbol,
} from '@0dtetrader/shared-types';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma, type IvAlertDetectorState as PersistedDetectorState } from '@prisma/client';
import { EventTransportService } from '../events/event-transport.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_IV_ALERT_CONFIGURATION,
  advanceIvDetector,
  emptyIvDetectorState,
  type IvDetectorCapture,
  type IvDetectorResult,
  type IvDetectorSample,
  type IvDetectorState,
} from './iv-alert.detector';

const ALERT_SYMBOLS = new Set<IVAlertSymbol>(['SPX', 'NDX', 'RUT']);

export interface IvAlertEvent {
  userId: string;
  alert: IVAlert;
}

export interface IvAlertServiceMetrics {
  ignored: number;
  suppressed: number;
  tracking: number;
  alerts: number;
  detectorFailures: number;
  deliveryPublished: number;
  deliveryFailures: number;
}

interface ProcessedUserCapture {
  userId: string;
  event: IvAlertEvent | null;
  result: IvDetectorResult;
}

@Injectable()
export class IvAlertService {
  private readonly logger = new Logger(IvAlertService.name);
  readonly metrics: IvAlertServiceMetrics = {
    ignored: 0,
    suppressed: 0,
    tracking: 0,
    alerts: 0,
    detectorFailures: 0,
    deliveryPublished: 0,
    deliveryFailures: 0,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventTransport: EventTransportService,
  ) {}

  async getConfiguration(userId: string): Promise<IVAlertConfigurationState> {
    const existing = await this.prisma.ivAlertPreference.findUnique({ where: { userId } });
    if (existing) return configurationState(existing);
    const created = await this.prisma.ivAlertPreference.upsert({
      where: { userId },
      create: { userId, ...DEFAULT_IV_ALERT_CONFIGURATION },
      update: {},
    });
    return configurationState(created);
  }

  async configure(
    userId: string,
    configuration: IVAlertConfiguration,
  ): Promise<IVAlertConfigurationState> {
    validateConfiguration(configuration);
    const configured = await this.prisma.$transaction(async (database) => {
      await lockUser(database, userId);
      const existing = await database.ivAlertPreference.findUnique({ where: { userId } });
      const updatedAt = nextConfigurationUpdatedAt(existing?.updatedAt);
      const row = await database.ivAlertPreference.upsert({
        where: { userId },
        create: { userId, ...configuration, updatedAt },
        update: { ...configuration, schemaVersion: 1, updatedAt },
      });
      await database.ivAlertDetectorState.deleteMany({ where: { userId } });
      const state = configurationState(row);
      await this.eventTransport.publishInTransaction(
        database,
        userId,
        'ivAlertConfiguration',
        state,
      );
      return state;
    });
    try {
      await this.eventTransport.pollOnce();
    } catch (error) {
      // The event is already committed atomically with the preference update.
      // Scheduled polling on every instance will retry durable delivery.
      this.logger.warn(
        JSON.stringify({
          event: 'iv_alert_configuration_poll_failed',
          userId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return configured;
  }

  async processCapture(capture: IvDetectorCapture): Promise<IvAlertEvent[]> {
    const preferences = await this.prisma.ivAlertPreference.findMany({
      where: { enabled: true, symbols: { has: capture.symbol } },
      select: { userId: true },
    });
    const results = await Promise.all(
      preferences.map(async ({ userId }) => {
        try {
          return await this.processUserCapture(userId, capture);
        } catch (error) {
          this.metrics.detectorFailures += 1;
          this.logger.error(
            JSON.stringify({
              event: 'iv_alert_detector_failed',
              userId,
              symbol: capture.symbol,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
          return null;
        }
      }),
    );
    const processed = results.filter((result): result is ProcessedUserCapture => result !== null);
    for (const item of processed) {
      this.metrics[item.result.kind === 'alert' ? 'alerts' : item.result.kind] += 1;
      if (item.event) this.metrics.deliveryPublished += 1;
      this.logger.log(
        JSON.stringify({
          event: 'iv_alert_detector_decision',
          userId: item.userId,
          symbol: capture.symbol,
          kind: item.result.kind,
          reason: item.result.reason,
          direction: item.result.direction,
        }),
      );
    }
    const events = processed.flatMap((item) => (item.event ? [item.event] : []));
    if (events.length > 0) {
      try {
        await this.eventTransport.pollOnce();
      } catch (error) {
        this.metrics.deliveryFailures += 1;
        this.logger.error(
          JSON.stringify({
            event: 'iv_alert_delivery_poll_failed',
            symbol: capture.symbol,
            alertCount: events.length,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    if (processed.length !== results.length) {
      throw new Error('One or more IV alert detector transactions failed.');
    }
    return events;
  }

  private async processUserCapture(
    userId: string,
    capture: IvDetectorCapture,
  ): Promise<ProcessedUserCapture> {
    return this.prisma.$transaction(async (database) => {
      await lockUser(database, userId);
      const preference = await database.ivAlertPreference.findUnique({ where: { userId } });
      if (!preference) {
        return {
          userId,
          event: null,
          result: { kind: 'ignored', reason: 'disabled', state: emptyIvDetectorState() },
        };
      }
      const configuration = configurationFromRow(preference);

      const persisted = await database.ivAlertDetectorState.findUnique({
        where: { userId_symbol: { userId, symbol: capture.symbol } },
      });
      const current = persisted ? detectorStateFromRow(persisted) : emptyIvDetectorState();
      const result = advanceIvDetector(current, capture, configuration);
      if (result.state === current) return { userId, event: null, result };
      const data = detectorStateData(result.state);
      if (persisted) {
        await database.ivAlertDetectorState.update({
          where: { id: persisted.id },
          data: { ...data, version: persisted.version + 1 },
        });
      } else {
        await database.ivAlertDetectorState.create({
          data: { userId, symbol: capture.symbol, ...data },
        });
      }
      const event = result.alert ? { userId, alert: result.alert } : null;
      if (event) {
        try {
          await this.eventTransport.publishInTransaction(
            database,
            userId,
            'ivAlert',
            event.alert,
            `iv-alert:${capture.symbol}:${event.alert.timestamp}:${event.alert.direction}`,
          );
        } catch (error) {
          this.metrics.deliveryFailures += 1;
          throw error;
        }
      }
      return { userId, event, result };
    });
  }
}

function nextConfigurationUpdatedAt(previous?: Date): Date {
  return new Date(Math.max(Date.now(), (previous?.getTime() ?? -1) + 1));
}

function validateConfiguration(configuration: IVAlertConfiguration): void {
  if (typeof configuration.enabled !== 'boolean') invalid('enabled');
  if (
    !Array.isArray(configuration.symbols) ||
    configuration.symbols.length < 1 ||
    configuration.symbols.length > 3 ||
    new Set(configuration.symbols).size !== configuration.symbols.length ||
    configuration.symbols.some((symbol) => !ALERT_SYMBOLS.has(symbol))
  ) {
    invalid('symbols');
  }
  boundedInteger(configuration.lookbackMinutes, 5, 240, 'lookbackMinutes');
  boundedNumber(configuration.thresholdK, 0.1, 20, 'thresholdK');
  boundedInteger(configuration.consecutiveBreaches, 1, 10, 'consecutiveBreaches');
  boundedInteger(configuration.warmupMinutes, 0, 60, 'warmupMinutes');
  boundedInteger(configuration.warmupSamples, 1, 240, 'warmupSamples');
  boundedInteger(configuration.cooldownMinutes, 0, 1440, 'cooldownMinutes');
}

function boundedInteger(value: number, min: number, max: number, field: string): void {
  if (!Number.isInteger(value) || value < min || value > max) invalid(field);
}

function boundedNumber(value: number, min: number, max: number, field: string): void {
  if (!Number.isFinite(value) || value < min || value > max) invalid(field);
}

function invalid(field: string): never {
  throw new BadRequestException(`Invalid IV alert ${field}.`);
}

function configurationFromRow(row: {
  enabled: boolean;
  symbols: string[];
  lookbackMinutes: number;
  thresholdK: number;
  consecutiveBreaches: number;
  warmupMinutes: number;
  warmupSamples: number;
  cooldownMinutes: number;
}): IVAlertConfiguration {
  const configuration: IVAlertConfiguration = {
    enabled: row.enabled,
    symbols: [...row.symbols] as IVAlertSymbol[],
    lookbackMinutes: row.lookbackMinutes,
    thresholdK: row.thresholdK,
    consecutiveBreaches: row.consecutiveBreaches,
    warmupMinutes: row.warmupMinutes,
    warmupSamples: row.warmupSamples,
    cooldownMinutes: row.cooldownMinutes,
  };
  validateConfiguration(configuration);
  return configuration;
}

function configurationState(
  row: Parameters<typeof configurationFromRow>[0] & {
    schemaVersion: number;
    updatedAt: Date;
  },
): IVAlertConfigurationState {
  if (row.schemaVersion !== 1) throw new Error('Unsupported IV alert configuration version.');
  return {
    ...configurationFromRow(row),
    schemaVersion: 1,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function detectorStateFromRow(row: PersistedDetectorState): IvDetectorState {
  if (!Array.isArray(row.samples)) throw new Error('Invalid persisted IV detector samples.');
  const samples = row.samples.map((sample): IvDetectorSample => {
    if (sample === null || typeof sample !== 'object' || Array.isArray(sample)) {
      throw new Error('Invalid persisted IV detector sample.');
    }
    const timestamp = 'timestamp' in sample ? sample.timestamp : null;
    const atmIv = 'atmIv' in sample ? sample.atmIv : null;
    if (
      typeof timestamp !== 'string' ||
      !Number.isFinite(Date.parse(timestamp)) ||
      typeof atmIv !== 'number' ||
      !Number.isFinite(atmIv) ||
      atmIv <= 0
    ) {
      throw new Error('Invalid persisted IV detector sample.');
    }
    return { timestamp, atmIv };
  });
  const direction = row.streakDirection;
  if (direction !== null && direction !== 'expansion' && direction !== 'crush') {
    throw new Error('Invalid persisted IV detector direction.');
  }
  if (!Number.isInteger(row.streakCount) || row.streakCount < 0) {
    throw new Error('Invalid persisted IV detector streak.');
  }
  return {
    samples,
    firstPostResetAt: row.firstPostResetAt?.toISOString() ?? null,
    lastProcessedAt: row.lastProcessedAt?.toISOString() ?? null,
    streakDirection: direction as IVAlertDirection | null,
    streakCount: row.streakCount,
    cooldownUntil: row.cooldownUntil?.toISOString() ?? null,
  };
}

function detectorStateData(state: IvDetectorState): {
  samples: Prisma.InputJsonValue;
  firstPostResetAt: Date | null;
  lastProcessedAt: Date | null;
  streakDirection: IVAlertDirection | null;
  streakCount: number;
  cooldownUntil: Date | null;
} {
  return {
    samples: state.samples as unknown as Prisma.InputJsonValue,
    firstPostResetAt: state.firstPostResetAt ? new Date(state.firstPostResetAt) : null,
    lastProcessedAt: state.lastProcessedAt ? new Date(state.lastProcessedAt) : null,
    streakDirection: state.streakDirection,
    streakCount: state.streakCount,
    cooldownUntil: state.cooldownUntil ? new Date(state.cooldownUntil) : null,
  };
}

async function lockUser(database: Prisma.TransactionClient, userId: string): Promise<void> {
  await database.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${'iv-alert:' + userId}))`,
  );
}
