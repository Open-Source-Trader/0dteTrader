import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { BrokerGateway } from '../src/broker/broker-gateway.interface';
import { EventTransportService } from '../src/events/event-transport.service';
import { StreamGateway } from '../src/market-data/stream.gateway';
import { CryptoDataService } from '../src/market-data/crypto-data.service';
import { IndexDataService } from '../src/market-data/index-data.service';
import { PrismaService } from '../src/prisma/prisma.service';

const postgresDescribe = process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;

function fakeSocket(): { readyState: number; send: jest.Mock; close: jest.Mock } {
  return { readyState: WebSocket.OPEN, send: jest.fn(), close: jest.fn() };
}

postgresDescribe('Event transport (two real Postgres clients)', () => {
  let databaseA: PrismaService;
  let databaseB: PrismaService;
  let receiver: EventTransportService;
  let producer: EventTransportService;
  let gateway: StreamGateway;
  let userId: string;

  beforeAll(async () => {
    databaseA = new PrismaService();
    databaseB = new PrismaService();
    await Promise.all([databaseA.onModuleInit(), databaseB.onModuleInit()]);
    userId = (
      await databaseA.user.create({
        data: { email: `event-transport-${randomUUID()}@example.test`, passwordHash: 'test' },
      })
    ).id;
    receiver = new EventTransportService(databaseA);
    producer = new EventTransportService(databaseB);
    await receiver.onModuleInit();
    gateway = new StreamGateway(
      {} as BrokerGateway,
      {} as CryptoDataService,
      {} as IndexDataService,
      {} as never,
      {} as never,
      receiver,
    );
  });

  afterAll(async () => {
    gateway?.onModuleDestroy();
    receiver?.onModuleDestroy();
    producer?.onModuleDestroy();
    if (userId) await databaseA.user.delete({ where: { id: userId } }).catch(() => undefined);
    await Promise.all([
      databaseA ? databaseA.onModuleDestroy() : Promise.resolve(),
      databaseB ? databaseB.onModuleDestroy() : Promise.resolve(),
    ]);
  });

  it('delivers producer-B events to socket-A once and replays a missed suffix in order', async () => {
    const liveSocket = fakeSocket();
    const internals = gateway as unknown as {
      clients: Map<
        unknown,
        {
          userId: string;
          symbols: Set<string>;
          lastSequence: number;
          replaying: boolean;
          pending: unknown[];
        }
      >;
      replayClient(client: unknown, userId: string, cursor: number | null): Promise<void>;
    };
    internals.clients.set(liveSocket, {
      userId,
      symbols: new Set(),
      lastSequence: 0,
      replaying: false,
      pending: [],
    });

    await producer.publish(userId, 'orderUpdate', { orderId: 'remote-1' }, 'remote-1');
    await producer.publish(userId, 'chartOrder', { id: 'remote-2' }, 'remote-2');
    await receiver.pollOnce();
    await receiver.pollOnce();

    expect(
      liveSocket.send.mock.calls.map(([raw]) => {
        const message = JSON.parse(raw as string) as { sequence: number };
        return message.sequence;
      }),
    ).toEqual([1, 2]);

    internals.clients.delete(liveSocket);
    await producer.publish(userId, 'orderUpdate', { orderId: 'missed-3' }, 'missed-3');

    const reconnectSocket = fakeSocket();
    internals.clients.set(reconnectSocket, {
      userId,
      symbols: new Set(),
      lastSequence: 1,
      replaying: true,
      pending: [],
    });
    await internals.replayClient(reconnectSocket, userId, 1);

    const replay = reconnectSocket.send.mock.calls.map(([raw]) => JSON.parse(raw as string));
    expect(replay.map((message) => message.type)).toEqual([
      'chartOrder',
      'orderUpdate',
      'eventCursor',
    ]);
    expect(replay.map((message) => message.sequence)).toEqual([2, 3, 3]);
  });

  it('serializes concurrent allocation across two real database connections', async () => {
    const burstUser = await databaseA.user.create({
      data: { email: `event-burst-${randomUUID()}@example.test`, passwordHash: 'test' },
    });
    try {
      const published = await Promise.all(
        Array.from({ length: 32 }, (_, index) =>
          (index % 2 === 0 ? receiver : producer).publish(
            burstUser.id,
            'orderUpdate',
            { orderId: `burst-${index}` },
            `burst-${index}`,
          ),
        ),
      );
      expect(published.map((event) => event.sequence).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 32 }, (_, index) => index + 1),
      );

      const rows = await databaseA.userEvent.findMany({
        where: { userId: burstUser.id },
        orderBy: { ordinal: 'asc' },
      });
      expect(rows.map((row) => row.sequence)).toEqual(
        Array.from({ length: 32 }, (_, index) => index + 1),
      );
      expect(new Set(rows.map((row) => row.ordinal.toString())).size).toBe(32);
    } finally {
      await databaseA.user.delete({ where: { id: burstUser.id } });
    }
  });
});
