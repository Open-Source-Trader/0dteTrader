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

    const events = await Promise.all([
      first.publish(userId, 'orderUpdate', { orderId: '1' }, 'order:1:filled'),
      second.publish(userId, 'orderUpdate', { orderId: '2' }, 'order:2:filled'),
    ]);

    expect(events.map((event) => event.sequence).sort()).toEqual([1, 2]);
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
});
