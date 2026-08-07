import { Subject } from 'rxjs';
import { WebSocket } from 'ws';
import { Logger } from '@nestjs/common';
import type { DurableUserEvent, EventTransportService } from '../events/event-transport.service';
import { EventTransportService as PostgresEventTransport } from '../events/event-transport.service';
import { InMemoryPrismaService } from '../../test/in-memory-prisma.service';
import { IvAlertService } from '../options-analytics/iv-alert.service';
import type { OrderBookService } from './order-book.service';
import { StreamGateway } from './stream.gateway';

function socket() {
  return { readyState: WebSocket.OPEN, send: jest.fn(), close: jest.fn() };
}

describe('StreamGateway IV alerts', () => {
  it('sends the authenticated user persisted configuration on connection', async () => {
    const events = new Subject<DurableUserEvent>();
    const persisted = {
      enabled: false,
      symbols: ['SPX', 'NDX', 'RUT'],
      lookbackMinutes: 30,
      thresholdK: 3,
      consecutiveBreaches: 2,
      warmupMinutes: 15,
      warmupSamples: 10,
      cooldownMinutes: 15,
      schemaVersion: 1,
      updatedAt: '2026-08-05T15:00:00.000Z',
    };
    const ivAlerts = {
      getConfiguration: jest.fn().mockResolvedValue(persisted),
      onAlert: jest.fn(() => jest.fn()),
    };
    const gateway = new StreamGateway(
      {} as never,
      { isCryptoSymbol: jest.fn(() => false) } as never,
      { isIndexSymbol: jest.fn(() => false) } as never,
      {} as never,
      {} as never,
      { events$: events.asObservable() } as unknown as EventTransportService,
      { destroy: jest.fn() } as unknown as OrderBookService,
      ivAlerts as unknown as IvAlertService,
    );
    const client = socket();
    const state = {
      userId: 'user-1',
      symbols: new Set<string>(),
      l2Symbols: new Set<string>(),
      lastSequence: 0,
      replaying: false,
      pending: [] as DurableUserEvent[],
    };
    const internals = gateway as unknown as {
      clients: Map<unknown, typeof state>;
      sendInitialIvAlertConfiguration(client: unknown, state: unknown): Promise<void>;
    };
    internals.clients.set(client, state);

    await internals.sendInitialIvAlertConfiguration(client, state);

    expect(ivAlerts.getConfiguration).toHaveBeenCalledWith('user-1');
    expect(JSON.parse(client.send.mock.calls[0][0])).toEqual({
      type: 'ivAlertConfiguration',
      data: persisted,
    });
    gateway.onModuleDestroy();
  });

  it('does not let a delayed older configuration event overwrite the initial database state', async () => {
    const events = new Subject<DurableUserEvent>();
    const latest = {
      enabled: false,
      symbols: ['SPX', 'NDX', 'RUT'],
      lookbackMinutes: 30,
      thresholdK: 3,
      consecutiveBreaches: 2,
      warmupMinutes: 15,
      warmupSamples: 10,
      cooldownMinutes: 15,
      schemaVersion: 1 as const,
      updatedAt: '2026-08-05T15:02:00.000Z',
    };
    const gateway = new StreamGateway(
      {} as never,
      { isCryptoSymbol: jest.fn(() => false) } as never,
      { isIndexSymbol: jest.fn(() => false) } as never,
      {} as never,
      {} as never,
      { events$: events.asObservable() } as unknown as EventTransportService,
      { destroy: jest.fn() } as unknown as OrderBookService,
      { getConfiguration: jest.fn().mockResolvedValue(latest) } as unknown as IvAlertService,
    );
    const client = socket();
    const state = {
      userId: 'user-1',
      symbols: new Set<string>(),
      l2Symbols: new Set<string>(),
      lastSequence: 0,
      replaying: false,
      pending: [] as DurableUserEvent[],
    };
    const internals = gateway as unknown as {
      clients: Map<unknown, typeof state>;
      sendInitialIvAlertConfiguration(client: unknown, state: unknown): Promise<void>;
    };
    internals.clients.set(client, state);

    await internals.sendInitialIvAlertConfiguration(client, state);
    events.next({
      id: 'stale-configuration',
      userId: 'user-1',
      sequence: 1,
      type: 'ivAlertConfiguration',
      payload: {
        ...latest,
        enabled: true,
        updatedAt: '2026-08-05T15:01:00.000Z',
      },
    });

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(client.send.mock.calls[0][0])).toEqual({
      type: 'ivAlertConfiguration',
      data: latest,
    });
    expect(gateway.metrics.ivAlertConfigurationFanout).toBe(0);
    gateway.onModuleDestroy();
  });

  it('persists authenticated configuration, acknowledges it, and scopes alerts to the user', async () => {
    const events = new Subject<DurableUserEvent>();
    const configuration = {
      enabled: true,
      symbols: ['SPX'] as const,
      lookbackMinutes: 30,
      thresholdK: 3,
      consecutiveBreaches: 2,
      warmupMinutes: 10,
      warmupSamples: 10,
      cooldownMinutes: 5,
    };
    const ivAlerts = {
      configure: jest.fn().mockResolvedValue({
        ...configuration,
        symbols: ['SPX'],
        schemaVersion: 1,
        updatedAt: '2026-08-05T15:00:00.000Z',
      }),
    };
    const orderBooks = {
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
      disconnect: jest.fn(),
      destroy: jest.fn(),
    };
    const gateway = new StreamGateway(
      {} as never,
      { isCryptoSymbol: jest.fn(() => false) } as never,
      { isIndexSymbol: jest.fn(() => false) } as never,
      {} as never,
      {} as never,
      {
        events$: events.asObservable(),
        replay: jest.fn(),
        latestSequence: jest.fn(),
        pollOnce: jest.fn(),
      } as unknown as EventTransportService,
      orderBooks as unknown as OrderBookService,
      ivAlerts as unknown as IvAlertService,
    );
    const owner = socket();
    const secondOwnerSocket = socket();
    const other = socket();
    const state = (userId: string) => ({
      userId,
      symbols: new Set<string>(),
      l2Symbols: new Set<string>(),
      lastSequence: 0,
      replaying: false,
      pending: [] as DurableUserEvent[],
    });
    const internals = gateway as unknown as {
      clients: Map<unknown, ReturnType<typeof state>>;
      handleMessage(client: unknown, raw: unknown): void;
    };
    internals.clients.set(owner, state('user-1'));
    internals.clients.set(secondOwnerSocket, state('user-1'));
    internals.clients.set(other, state('user-2'));

    internals.handleMessage(
      owner,
      JSON.stringify({ type: 'ivAlertConfigure', data: configuration }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(ivAlerts.configure).toHaveBeenCalledWith('user-1', configuration);
    expect(JSON.parse(owner.send.mock.calls[0][0])).toMatchObject({
      type: 'ivAlertConfiguration',
      data: { schemaVersion: 1, enabled: true, symbols: ['SPX'] },
    });
    expect(JSON.parse(secondOwnerSocket.send.mock.calls[0][0])).toMatchObject({
      type: 'ivAlertConfiguration',
      data: { schemaVersion: 1, enabled: true, symbols: ['SPX'] },
    });
    expect(other.send).not.toHaveBeenCalled();
    expect(gateway.metrics.ivAlertConfigurationFanout).toBe(2);

    events.next({
      id: 'iv-alert-1',
      userId: 'user-1',
      sequence: 1,
      type: 'ivAlert',
      payload: {
        symbol: 'SPX',
        direction: 'expansion',
        currentIv: 0.3,
        baselineIv: 0.2,
        zScore: 4,
        timestamp: '2026-08-05T15:01:00.000Z',
      },
    });
    expect(owner.send).toHaveBeenCalledTimes(2);
    expect(secondOwnerSocket.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(secondOwnerSocket.send.mock.calls[1][0]).type).toBe('ivAlert');
    expect(other.send).not.toHaveBeenCalled();

    gateway.onModuleDestroy();
  });

  it('fans configuration out live across two API instances once and never replays it', async () => {
    const prisma = new InMemoryPrismaService();
    const userId = (
      await prisma.user.create({ data: { email: 'remote-config@example.com', passwordHash: 'x' } })
    ).id;
    const otherUserId = (
      await prisma.user.create({
        data: { email: 'remote-config-other@example.com', passwordHash: 'x' },
      })
    ).id;
    const producer = new PostgresEventTransport(prisma as never);
    const receiver = new PostgresEventTransport(prisma as never);
    const ivAlerts = new IvAlertService(prisma as never, producer);
    const makeGateway = (transport: EventTransportService, service?: IvAlertService) =>
      new StreamGateway(
        {} as never,
        { isCryptoSymbol: jest.fn(() => false) } as never,
        { isIndexSymbol: jest.fn(() => false) } as never,
        {} as never,
        {} as never,
        transport,
        { destroy: jest.fn() } as unknown as OrderBookService,
        service,
      );
    const localGateway = makeGateway(producer, ivAlerts);
    const remoteGateway = makeGateway(receiver);
    const local = socket();
    const remote = socket();
    const other = socket();
    const state = (id: string, replaying = false) => ({
      userId: id,
      symbols: new Set<string>(),
      l2Symbols: new Set<string>(),
      lastSequence: 0,
      replaying,
      pending: [] as DurableUserEvent[],
    });
    const localInternals = localGateway as unknown as {
      clients: Map<unknown, ReturnType<typeof state>>;
      handleMessage(client: unknown, raw: unknown): void;
    };
    const remoteInternals = remoteGateway as unknown as {
      clients: Map<unknown, ReturnType<typeof state>>;
      replayClient(client: unknown, id: string, cursor: number | null): Promise<void>;
    };
    localInternals.clients.set(local, state(userId));
    remoteInternals.clients.set(remote, state(userId));
    remoteInternals.clients.set(other, state(otherUserId));
    const configuration = {
      enabled: true,
      symbols: ['SPX'],
      lookbackMinutes: 30,
      thresholdK: 3,
      consecutiveBreaches: 2,
      warmupMinutes: 10,
      warmupSamples: 10,
      cooldownMinutes: 5,
    };

    try {
      localInternals.handleMessage(
        local,
        JSON.stringify({ type: 'ivAlertConfigure', data: configuration }),
      );
      await new Promise((resolve) => setImmediate(resolve));
      await receiver.pollOnce();
      await receiver.pollOnce();

      expect(prisma.userEvents).toHaveLength(1);
      expect(prisma.userEvents[0]).toMatchObject({
        userId,
        type: 'ivAlertConfiguration',
        payload: expect.objectContaining({ enabled: true, symbols: ['SPX'], schemaVersion: 1 }),
      });
      expect(local.send).toHaveBeenCalledTimes(1);
      expect(remote.send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(local.send.mock.calls[0][0])).toMatchObject({
        type: 'ivAlertConfiguration',
        data: { enabled: true, symbols: ['SPX'], schemaVersion: 1 },
      });
      expect(JSON.parse(remote.send.mock.calls[0][0])).toMatchObject({
        type: 'ivAlertConfiguration',
        data: { enabled: true, symbols: ['SPX'], schemaVersion: 1 },
      });
      expect(other.send).not.toHaveBeenCalled();
      expect(localGateway.metrics.ivAlertConfigurationFanout).toBe(1);
      expect(remoteGateway.metrics.ivAlertConfigurationFanout).toBe(1);

      const reconnect = socket();
      const reconnectState = state(userId, true);
      remoteInternals.clients.set(reconnect, reconnectState);
      await remoteInternals.replayClient(reconnect, userId, 0);
      expect(reconnect.send.mock.calls.map(([raw]) => JSON.parse(raw).type)).toEqual([
        'eventCursor',
      ]);
      expect(JSON.parse(reconnect.send.mock.calls[0][0])).toEqual({
        type: 'eventCursor',
        sequence: 1,
      });
    } finally {
      localGateway.onModuleDestroy();
      remoteGateway.onModuleDestroy();
      producer.onModuleDestroy();
      receiver.onModuleDestroy();
    }
  });

  it('returns a typed error when configuration validation fails', async () => {
    const events = new Subject<DurableUserEvent>();
    const ivAlerts = {
      configure: jest.fn().mockRejectedValue(new Error('Invalid IV alert symbols.')),
      onAlert: jest.fn(() => jest.fn()),
    };
    const gateway = new StreamGateway(
      {} as never,
      { isCryptoSymbol: jest.fn(() => false) } as never,
      { isIndexSymbol: jest.fn(() => false) } as never,
      {} as never,
      {} as never,
      { events$: events.asObservable() } as unknown as EventTransportService,
      { destroy: jest.fn() } as unknown as OrderBookService,
      ivAlerts as unknown as IvAlertService,
    );
    const client = socket();
    const internals = gateway as unknown as {
      clients: Map<unknown, unknown>;
      handleMessage(client: unknown, raw: unknown): void;
    };
    internals.clients.set(client, {
      userId: 'user-1',
      symbols: new Set(),
      l2Symbols: new Set(),
      lastSequence: 0,
      replaying: false,
      pending: [],
    });

    internals.handleMessage(
      client,
      JSON.stringify({ type: 'ivAlertConfigure', data: { enabled: true, symbols: [] } }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(JSON.parse(client.send.mock.calls[0][0])).toEqual({
      type: 'error',
      error: {
        code: 'IV_ALERT_CONFIGURATION_INVALID',
        message: 'Invalid IV alert symbols.',
      },
    });
    gateway.onModuleDestroy();
  });

  it('delivers a user-scoped IV alert from another API instance exactly once', async () => {
    const prisma = new InMemoryPrismaService();
    const userId = (
      await prisma.user.create({ data: { email: 'remote-alert@example.com', passwordHash: 'x' } })
    ).id;
    const otherUserId = (
      await prisma.user.create({ data: { email: 'other-alert@example.com', passwordHash: 'x' } })
    ).id;
    const producer = new PostgresEventTransport(prisma as never);
    const receiver = new PostgresEventTransport(prisma as never);
    const gateway = new StreamGateway(
      {} as never,
      { isCryptoSymbol: jest.fn(() => false) } as never,
      { isIndexSymbol: jest.fn(() => false) } as never,
      {} as never,
      {} as never,
      receiver,
      { destroy: jest.fn() } as unknown as OrderBookService,
    );
    const owner = socket();
    const other = socket();
    const state = (id: string) => ({
      userId: id,
      symbols: new Set<string>(),
      l2Symbols: new Set<string>(),
      lastSequence: 0,
      replaying: false,
      pending: [] as DurableUserEvent[],
    });
    const internals = gateway as unknown as {
      clients: Map<unknown, ReturnType<typeof state>>;
      metrics: { ivAlertDelivered: number; ivAlertDeliveryFailures: number };
    };
    internals.clients.set(owner, state(userId));
    internals.clients.set(other, state(otherUserId));
    const alert = {
      symbol: 'SPX',
      direction: 'expansion',
      currentIv: 0.3,
      baselineIv: 0.2,
      zScore: 4,
      timestamp: '2026-08-05T15:01:00.000Z',
    };

    try {
      await producer.publish(userId, 'ivAlert' as never, alert, 'iv-alert:SPX:15:01');
      await receiver.pollOnce();
      await receiver.pollOnce();

      expect(owner.send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(owner.send.mock.calls[0][0])).toEqual({ type: 'ivAlert', data: alert });
      expect(other.send).not.toHaveBeenCalled();
      expect(internals.metrics).toMatchObject({
        ivAlertDelivered: 1,
        ivAlertDeliveryFailures: 0,
      });
    } finally {
      gateway.onModuleDestroy();
      producer.onModuleDestroy();
      receiver.onModuleDestroy();
    }
  });

  it('does not replay a historical IV alert after reconnect', async () => {
    const prisma = new InMemoryPrismaService();
    const userId = (
      await prisma.user.create({ data: { email: 'no-replay@example.com', passwordHash: 'x' } })
    ).id;
    const transport = new PostgresEventTransport(prisma as never);
    await transport.publish(
      userId,
      'ivAlert' as never,
      {
        symbol: 'SPX',
        direction: 'crush',
        currentIv: 0.15,
        baselineIv: 0.2,
        zScore: -4,
        timestamp: '2026-08-05T15:01:00.000Z',
      },
      'iv-alert:SPX:15:01',
    );
    const gateway = new StreamGateway(
      {} as never,
      { isCryptoSymbol: jest.fn(() => false) } as never,
      { isIndexSymbol: jest.fn(() => false) } as never,
      {} as never,
      {} as never,
      transport,
      { destroy: jest.fn() } as unknown as OrderBookService,
    );
    const client = socket();
    const state = {
      userId,
      symbols: new Set<string>(),
      l2Symbols: new Set<string>(),
      lastSequence: 0,
      replaying: true,
      pending: [] as DurableUserEvent[],
    };
    const internals = gateway as unknown as {
      clients: Map<unknown, typeof state>;
      replayClient(client: unknown, id: string, cursor: number | null): Promise<void>;
    };
    internals.clients.set(client, state);

    try {
      await internals.replayClient(client, userId, 0);
      expect(client.send.mock.calls.map(([raw]) => JSON.parse(raw).type)).toEqual(['eventCursor']);
      expect(JSON.parse(client.send.mock.calls[0][0])).toEqual({
        type: 'eventCursor',
        sequence: 1,
      });
    } finally {
      gateway.onModuleDestroy();
      transport.onModuleDestroy();
    }
  });

  it('delivers a live IV alert queued during replay exactly once', async () => {
    const events = new Subject<DurableUserEvent>();
    const alertEvent: DurableUserEvent = {
      id: 'live-during-replay',
      userId: 'user-1',
      sequence: 7,
      type: 'ivAlert',
      payload: {
        symbol: 'SPX',
        direction: 'expansion',
        currentIv: 0.3,
        baselineIv: 0.2,
        zScore: 4,
        timestamp: '2026-08-05T15:01:00.000Z',
      },
    };
    const transport = {
      events$: events.asObservable(),
      replay: jest.fn().mockResolvedValue([alertEvent]),
    } as unknown as EventTransportService;
    const gateway = new StreamGateway(
      {} as never,
      { isCryptoSymbol: jest.fn(() => false) } as never,
      { isIndexSymbol: jest.fn(() => false) } as never,
      {} as never,
      {} as never,
      transport,
      { destroy: jest.fn() } as unknown as OrderBookService,
    );
    const client = socket();
    const state = {
      userId: 'user-1',
      symbols: new Set<string>(),
      l2Symbols: new Set<string>(),
      lastSequence: 0,
      replaying: true,
      pending: [] as DurableUserEvent[],
    };
    const internals = gateway as unknown as {
      clients: Map<unknown, typeof state>;
      replayClient(client: unknown, id: string, cursor: number | null): Promise<void>;
    };
    internals.clients.set(client, state);
    events.next(alertEvent);

    await internals.replayClient(client, 'user-1', 0);

    expect(client.send.mock.calls.map(([raw]) => JSON.parse(raw).type)).toEqual([
      'ivAlert',
      'eventCursor',
    ]);
    expect(gateway.metrics.ivAlertDelivered).toBe(1);
    gateway.onModuleDestroy();
  });

  it('does not report a delivery failure merely because this replica has no user socket', () => {
    const events = new Subject<DurableUserEvent>();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const gateway = new StreamGateway(
      {} as never,
      { isCryptoSymbol: jest.fn(() => false) } as never,
      { isIndexSymbol: jest.fn(() => false) } as never,
      {} as never,
      {} as never,
      { events$: events.asObservable() } as unknown as EventTransportService,
      { destroy: jest.fn() } as unknown as OrderBookService,
    );

    events.next({
      id: 'missed-alert',
      userId: 'offline-user',
      sequence: 1,
      type: 'ivAlert',
      payload: {
        symbol: 'NDX',
        direction: 'crush',
        currentIv: 0.15,
        baselineIv: 0.2,
        zScore: -4,
        timestamp: '2026-08-05T15:01:00.000Z',
      },
    });

    expect(gateway.metrics.ivAlertDeliveryFailures).toBe(0);
    expect(warning).not.toHaveBeenCalledWith(
      expect.stringContaining('"event":"iv_alert_delivery_failed"'),
    );
    expect(log).not.toHaveBeenCalledWith(
      expect.stringContaining('"event":"iv_alert_delivery_missed"'),
    );
    gateway.onModuleDestroy();
    log.mockRestore();
    warning.mockRestore();
  });

  it('increments delivery failures only when a matching socket send actually fails', () => {
    const events = new Subject<DurableUserEvent>();
    const warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const gateway = new StreamGateway(
      {} as never,
      { isCryptoSymbol: jest.fn(() => false) } as never,
      { isIndexSymbol: jest.fn(() => false) } as never,
      {} as never,
      {} as never,
      { events$: events.asObservable() } as unknown as EventTransportService,
      { destroy: jest.fn() } as unknown as OrderBookService,
    );
    const client = socket();
    client.send.mockImplementation(() => {
      throw new Error('socket write failed');
    });
    const internals = gateway as unknown as {
      clients: Map<unknown, unknown>;
    };
    internals.clients.set(client, {
      userId: 'user-1',
      symbols: new Set(),
      l2Symbols: new Set(),
      lastSequence: 0,
      replaying: false,
      pending: [],
    });

    events.next({
      id: 'failed-alert',
      userId: 'user-1',
      sequence: 1,
      type: 'ivAlert',
      payload: {
        symbol: 'SPX',
        direction: 'expansion',
        currentIv: 0.3,
        baselineIv: 0.2,
        zScore: 4,
        timestamp: '2026-08-05T15:01:00.000Z',
      },
    });

    expect(gateway.metrics.ivAlertDeliveryFailures).toBe(1);
    expect(gateway.metrics.ivAlertDelivered).toBe(0);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('"event":"iv_alert_delivery_failed"'),
    );
    gateway.onModuleDestroy();
    warning.mockRestore();
  });
});
