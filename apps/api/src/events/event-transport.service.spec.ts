import { InMemoryPrismaService } from '../../test/in-memory-prisma.service';
import { EventTransportService } from './event-transport.service';

describe('EventTransportService', () => {
  let prisma: InMemoryPrismaService;
  let userId: string;

  beforeEach(async () => {
    prisma = new InMemoryPrismaService();
    userId = (
      await prisma.user.create({ data: { email: 'events@example.com', passwordHash: 'x' } })
    ).id;
  });

  it('allocates monotone per-user sequences under concurrent publishers', async () => {
    const first = new EventTransportService(prisma as never);
    const second = new EventTransportService(prisma as never);

    const events = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        (index % 2 === 0 ? first : second).publish(
          userId,
          'orderUpdate',
          { orderId: String(index + 1) },
          `order:${index + 1}:filled`,
        ),
      ),
    );

    expect(events.map((event) => event.sequence).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 32 }, (_, index) => index + 1),
    );
    expect(prisma.userEvents.map((event) => event.ordinal)).toEqual(
      Array.from({ length: 32 }, (_, index) => BigInt(index + 1)),
    );
  });

  it('deduplicates semantically identical events across instances', async () => {
    const first = new EventTransportService(prisma as never);
    const second = new EventTransportService(prisma as never);

    const [left, right] = await Promise.all([
      first.publish(userId, 'orderUpdate', { orderId: '1' }, 'order:1:filled'),
      second.publish(userId, 'orderUpdate', { orderId: '1' }, 'order:1:filled'),
    ]);

    expect(left.id).toBe(right.id);
    expect(prisma.userEvents).toHaveLength(1);
  });

  it('rolls the allocator back when the event insert fails', async () => {
    const service = new EventTransportService(prisma as never);
    const originalCreate = prisma.userEvent.create;
    let fail = true;
    prisma.userEvent.create = jest.fn(async (args: never) => {
      if (fail) {
        fail = false;
        throw new Error('insert failed');
      }
      return originalCreate(args);
    }) as never;

    await expect(
      service.publish(userId, 'orderUpdate', { orderId: 'failed' }, 'failed'),
    ).rejects.toThrow('insert failed');
    const recovered = await service.publish(
      userId,
      'orderUpdate',
      { orderId: 'recovered' },
      'recovered',
    );

    expect(recovered.sequence).toBe(1);
    expect(prisma.userEvents[0].ordinal).toBe(1n);
  });

  it('polls another instance and replays from a reconnect cursor', async () => {
    const publisher = new EventTransportService(prisma as never);
    const receiver = new EventTransportService(prisma as never);
    await receiver.onModuleInit();
    const seen: string[] = [];
    const subscription = receiver.events$.subscribe((event) => seen.push(event.id));
    try {
      const one = await publisher.publish(userId, 'orderUpdate', { orderId: '1' }, 'order:1');
      const two = await publisher.publish(userId, 'chartOrder', { id: 'line-1' }, 'chart:line-1');
      await receiver.pollOnce();

      expect(seen).toEqual([one.id, two.id]);
      expect((await receiver.replay(userId, one.sequence)).map((event) => event.id)).toEqual([
        two.id,
      ]);
    } finally {
      subscription.unsubscribe();
      receiver.onModuleDestroy();
    }
  });

  it('drains an unseen remote event before a newer local publish', async () => {
    const remote = new EventTransportService(prisma as never);
    const receiver = new EventTransportService(prisma as never);
    const seen: number[] = [];
    const subscription = receiver.events$.subscribe((event) => seen.push(event.sequence));
    try {
      await remote.publish(userId, 'orderUpdate', { orderId: 'remote' }, 'remote');
      await receiver.publish(userId, 'orderUpdate', { orderId: 'local' }, 'local');

      expect(seen).toEqual([1, 2]);
    } finally {
      subscription.unsubscribe();
    }
  });

  it('keeps a committed publish successful when its immediate poll fails', async () => {
    const service = new EventTransportService(prisma as never);
    const findMany = prisma.userEvent.findMany;
    let fail = true;
    prisma.userEvent.findMany = jest.fn(async (args: never) => {
      if (fail) {
        fail = false;
        throw new Error('temporary database outage');
      }
      return findMany(args);
    }) as never;

    const event = await service.publish(userId, 'orderUpdate', { orderId: '1' }, 'order:1');

    expect(event.sequence).toBe(1);
    expect(prisma.userEvents).toHaveLength(1);
    await service.pollOnce();
  });

  it('contains initial and scheduled poll rejections', async () => {
    jest.useFakeTimers();
    const service = new EventTransportService(prisma as never);
    prisma.userEvent.findMany = jest.fn(async () => {
      throw new Error('database temporarily unavailable');
    }) as never;
    try {
      await expect(service.onModuleInit()).resolves.toBeUndefined();
      await jest.advanceTimersByTimeAsync(250);
      expect(prisma.userEvent.findMany).toHaveBeenCalledTimes(2);
    } finally {
      service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('drains every page rather than waiting for later timer ticks', async () => {
    const service = new EventTransportService(prisma as never);
    for (let index = 1; index <= 501; index += 1) {
      prisma.userEvents.push({
        ordinal: BigInt(index),
        id: `event-${index}`,
        userId,
        sequence: index,
        dedupeKey: null,
        type: 'orderUpdate',
        payload: { orderId: String(index) },
        createdAt: new Date(),
      });
    }
    const seen: number[] = [];
    const subscription = service.events$.subscribe((event) => seen.push(event.sequence));
    try {
      await service.pollOnce();
      expect(seen).toHaveLength(501);
      expect(seen[0]).toBe(1);
      expect(seen[500]).toBe(501);
    } finally {
      subscription.unsubscribe();
    }
  });

  it('coalesces an overlapping poll into a follow-up drain', async () => {
    const service = new EventTransportService(prisma as never);
    const originalFindMany = prisma.userEvent.findMany;
    let releaseFirst!: (rows: never[]) => void;
    let firstQueryStarted!: () => void;
    const started = new Promise<void>((resolve) => (firstQueryStarted = resolve));
    let queryCount = 0;
    prisma.userEvent.findMany = jest.fn(async (args: never) => {
      queryCount += 1;
      if (queryCount === 1) {
        firstQueryStarted();
        return new Promise<never[]>((resolve) => (releaseFirst = resolve));
      }
      return originalFindMany(args);
    }) as never;
    const seen: number[] = [];
    const subscription = service.events$.subscribe((event) => seen.push(event.sequence));
    try {
      const firstPoll = service.pollOnce();
      await started;
      prisma.userEvents.push({
        ordinal: 1n,
        id: 'event-1',
        userId,
        sequence: 1,
        dedupeKey: null,
        type: 'orderUpdate',
        payload: { orderId: '1' },
        createdAt: new Date(),
      });
      const overlappingPoll = service.pollOnce();
      releaseFirst([]);
      await Promise.all([firstPoll, overlappingPoll]);

      expect(seen).toEqual([1]);
      expect(queryCount).toBeGreaterThanOrEqual(2);
    } finally {
      subscription.unsubscribe();
    }
  });
});
