import type { IVAlertConfiguration, IVAlertConfigurationState } from '@0dtetrader/shared-types';
import { BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InMemoryPrismaService } from '../../test/in-memory-prisma.service';
import { EventTransportService } from '../events/event-transport.service';
import { DEFAULT_IV_ALERT_CONFIGURATION } from './iv-alert.detector';
import { IvAlertService } from './iv-alert.service';

const at = (minute: number) => new Date(Date.parse('2026-08-05T13:30:00.000Z') + minute * 60_000);

const enabledConfiguration: IVAlertConfiguration = {
  ...DEFAULT_IV_ALERT_CONFIGURATION,
  enabled: true,
  symbols: ['SPX'],
  warmupMinutes: 0,
  warmupSamples: 3,
  consecutiveBreaches: 2,
};

async function createUser(prisma: InMemoryPrismaService, email: string): Promise<string> {
  const user = await prisma.user.create({ data: { email, passwordHash: 'hash' } });
  return user.id;
}

function serviceFor(prisma: InMemoryPrismaService): IvAlertService {
  return new IvAlertService(
    prisma as unknown as PrismaService,
    new EventTransportService(prisma as never),
  );
}

describe('IvAlertService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('materializes one disabled versioned default configuration per user', async () => {
    const prisma = new InMemoryPrismaService();
    const userId = await createUser(prisma, 'default@example.com');
    const service = serviceFor(prisma);

    const first = await service.getConfiguration(userId);
    const second = await service.getConfiguration(userId);

    expect(first).toMatchObject({
      ...DEFAULT_IV_ALERT_CONFIGURATION,
      schemaVersion: 1,
    });
    expect(Date.parse(first.updatedAt)).not.toBeNaN();
    expect(second).toEqual(first);
    expect(prisma.ivAlertPreferences).toHaveLength(1);
  });

  it.each([
    [{ ...enabledConfiguration, symbols: [] }, 'symbols'],
    [{ ...enabledConfiguration, symbols: ['SPX', 'SPX'] }, 'symbols'],
    [{ ...enabledConfiguration, lookbackMinutes: 4 }, 'lookbackMinutes'],
    [{ ...enabledConfiguration, thresholdK: Number.NaN }, 'thresholdK'],
    [{ ...enabledConfiguration, consecutiveBreaches: 1.5 }, 'consecutiveBreaches'],
    [{ ...enabledConfiguration, warmupSamples: 241 }, 'warmupSamples'],
    [{ ...enabledConfiguration, cooldownMinutes: -1 }, 'cooldownMinutes'],
  ])('rejects invalid persisted configuration %#', async (candidate, field) => {
    const prisma = new InMemoryPrismaService();
    const userId = await createUser(prisma, `${String(field)}@example.com`);
    const service = serviceFor(prisma);

    await expect(service.configure(userId, candidate as IVAlertConfiguration)).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.ivAlertPreferences).toHaveLength(0);
  });

  it('persists valid settings and returns the canonical versioned state', async () => {
    const prisma = new InMemoryPrismaService();
    const userId = await createUser(prisma, 'configured@example.com');
    const service = serviceFor(prisma);

    const configured = await service.configure(userId, enabledConfiguration);

    expect(configured).toMatchObject<Partial<IVAlertConfigurationState>>({
      ...enabledConfiguration,
      schemaVersion: 1,
    });
    expect(await service.getConfiguration(userId)).toEqual(configured);
    expect(prisma.userEvents).toEqual([
      expect.objectContaining({
        userId,
        type: 'ivAlertConfiguration',
        payload: configured,
      }),
    ]);
  });

  it('persists monotonic detector state across restart and emits only to the owning user', async () => {
    const prisma = new InMemoryPrismaService();
    const firstUserId = await createUser(prisma, 'first@example.com');
    const secondUserId = await createUser(prisma, 'second@example.com');
    const first = serviceFor(prisma);
    await first.configure(firstUserId, enabledConfiguration);
    await first.configure(secondUserId, { ...enabledConfiguration, symbols: ['NDX'] });
    for (let minute = 0; minute < 4; minute += 1) {
      await first.processCapture({
        symbol: 'SPX',
        timestamp: at(minute),
        atmIv: minute < 3 ? 0.2 : 0.5,
      });
    }
    expect(prisma.userEvents.filter((event) => event.type === 'ivAlert')).toEqual([]);
    expect(first.metrics).toMatchObject({ suppressed: 3, tracking: 1, alerts: 0 });
    expect(prisma.ivAlertDetectorStates).toHaveLength(1);
    const beforeRestart = structuredClone(prisma.ivAlertDetectorStates[0]);

    const restarted = serviceFor(prisma);
    const events = await restarted.processCapture({
      symbol: 'SPX',
      timestamp: at(4),
      atmIv: 0.5,
    });

    expect(events).toEqual([
      expect.objectContaining({
        userId: firstUserId,
        alert: expect.objectContaining({ symbol: 'SPX', direction: 'expansion' }),
      }),
    ]);
    const alertEvents = prisma.userEvents.filter((event) => event.type === 'ivAlert');
    expect(alertEvents).toHaveLength(1);
    expect(alertEvents[0]).toMatchObject({
      userId: firstUserId,
      type: 'ivAlert',
      payload: expect.objectContaining({ symbol: 'SPX', currentIv: 0.5 }),
    });
    expect(prisma.ivAlertDetectorStates).toHaveLength(1);
    expect(prisma.ivAlertDetectorStates[0].userId).toBe(firstUserId);
    expect(prisma.ivAlertDetectorStates[0].version).toBe(beforeRestart.version + 1);
    expect(restarted.metrics).toMatchObject({
      alerts: 1,
      deliveryPublished: 1,
      deliveryFailures: 0,
    });
    expect(Logger.prototype.log).toHaveBeenCalledWith(
      expect.stringContaining('"event":"iv_alert_detector_decision"'),
    );
  });

  it('does not mutate or emit for duplicate and older captures', async () => {
    const prisma = new InMemoryPrismaService();
    const userId = await createUser(prisma, 'monotonic@example.com');
    const service = serviceFor(prisma);
    await service.configure(userId, enabledConfiguration);
    await service.processCapture({ symbol: 'SPX', timestamp: at(0), atmIv: 0.2 });
    const before = structuredClone(prisma.ivAlertDetectorStates);
    expect(await service.processCapture({ symbol: 'SPX', timestamp: at(0), atmIv: 0.9 })).toEqual(
      [],
    );
    expect(await service.processCapture({ symbol: 'SPX', timestamp: at(-1), atmIv: 0.9 })).toEqual(
      [],
    );
    expect(prisma.ivAlertDetectorStates).toEqual(before);
    expect(prisma.userEvents.filter((event) => event.type === 'ivAlert')).toEqual([]);
    expect(service.metrics.ignored).toBe(2);
  });

  it('rolls detector state back when durable alert publication fails', async () => {
    const prisma = new InMemoryPrismaService();
    const userId = await createUser(prisma, 'atomic-delivery@example.com');
    const service = serviceFor(prisma);
    await service.configure(userId, enabledConfiguration);
    for (let minute = 0; minute < 4; minute += 1) {
      await service.processCapture({
        symbol: 'SPX',
        timestamp: at(minute),
        atmIv: minute < 3 ? 0.2 : 0.5,
      });
    }
    const before = structuredClone(prisma.ivAlertDetectorStates);
    const originalCreate = prisma.userEvent.create;
    prisma.userEvent.create = jest.fn(async () => {
      throw new Error('event transport unavailable');
    }) as never;

    await expect(
      service.processCapture({ symbol: 'SPX', timestamp: at(4), atmIv: 0.5 }),
    ).rejects.toThrow('detector transactions failed');
    expect(prisma.ivAlertDetectorStates).toEqual(before);
    expect(prisma.userEvents.filter((event) => event.type === 'ivAlert')).toEqual([]);
    expect(service.metrics.deliveryFailures).toBe(1);

    prisma.userEvent.create = originalCreate;
    await expect(
      service.processCapture({ symbol: 'SPX', timestamp: at(4), atmIv: 0.5 }),
    ).resolves.toHaveLength(1);
    expect(prisma.userEvents.filter((event) => event.type === 'ivAlert')).toHaveLength(1);
  });

  it('keeps detector history isolated by both user and symbol', async () => {
    const prisma = new InMemoryPrismaService();
    const firstUserId = await createUser(prisma, 'one@example.com');
    const secondUserId = await createUser(prisma, 'two@example.com');
    const service = serviceFor(prisma);
    await service.configure(firstUserId, { ...enabledConfiguration, symbols: ['SPX', 'NDX'] });
    await service.configure(secondUserId, enabledConfiguration);

    await service.processCapture({ symbol: 'SPX', timestamp: at(0), atmIv: 0.2 });
    await service.processCapture({ symbol: 'NDX', timestamp: at(0), atmIv: 0.3 });

    expect(prisma.ivAlertDetectorStates.map((row) => `${row.userId}:${row.symbol}`).sort()).toEqual(
      [`${firstUserId}:NDX`, `${firstUserId}:SPX`, `${secondUserId}:SPX`].sort(),
    );
    expect(
      prisma.ivAlertDetectorStates.find((row) => row.userId === firstUserId && row.symbol === 'NDX')
        ?.samples,
    ).toEqual([{ timestamp: at(0).toISOString(), atmIv: 0.3 }]);
  });
});
