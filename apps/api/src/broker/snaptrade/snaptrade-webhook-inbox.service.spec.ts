import { InMemoryPrismaService } from '../../../test/in-memory-prisma.service';
import { SnapTradeWebhookInboxService } from './snaptrade-webhook-inbox.service';
import { SnapTradeWebhookProcessorService } from './snaptrade-webhook-processor.service';

describe('SnapTradeWebhookInboxService', () => {
  let prisma: InMemoryPrismaService;
  let userId: string;

  beforeEach(async () => {
    prisma = new InMemoryPrismaService();
    userId = (await prisma.user.create({ data: { email: 'inbox@example.com', passwordHash: 'x' } }))
      .id;
  });

  const input = () => ({
    webhookId: 'wh-1',
    userId,
    environment: 'live' as const,
    eventType: 'CONNECTION_BROKEN',
    payload: { brokerageAuthorizationId: 'connection-1', raw: { preserved: true } },
  });

  it('commits the raw payload and treats a duplicate provider id as a no-op', async () => {
    const processor = { process: jest.fn() } as unknown as SnapTradeWebhookProcessorService;
    const service = new SnapTradeWebhookInboxService(prisma as never, processor);

    await service.enqueue(input());
    await service.enqueue(input());

    expect(prisma.webhookInboxRows).toHaveLength(1);
    expect(prisma.webhookInboxRows[0].payload).toEqual(input().payload);
    expect(prisma.webhookInboxRows[0].status).toBe('pending');
    await expect(service.exists(input().webhookId)).resolves.toBe(true);
    await expect(service.exists('unseen')).resolves.toBe(false);
  });

  it('lets two instances race while exactly one processor owns the lease', async () => {
    const process = jest.fn(async () => undefined);
    const processor = { process } as unknown as SnapTradeWebhookProcessorService;
    const first = new SnapTradeWebhookInboxService(prisma as never, processor);
    const second = new SnapTradeWebhookInboxService(prisma as never, processor);
    await first.enqueue(input());

    await Promise.all([first.processDue(), second.processDue()]);

    expect(process).toHaveBeenCalledTimes(1);
    expect(prisma.webhookInboxRows[0].status).toBe('processed');
  });

  it('recovers a lease left behind by a crashed worker', async () => {
    const process = jest.fn(async () => undefined);
    const service = new SnapTradeWebhookInboxService(
      prisma as never,
      { process } as unknown as SnapTradeWebhookProcessorService,
    );
    await service.enqueue(input());
    Object.assign(prisma.webhookInboxRows[0], {
      status: 'leased',
      leaseOwnerId: 'dead-instance',
      leaseExpiresAt: new Date('2026-08-05T12:00:00Z'),
    });

    await service.processDue(new Date('2026-08-05T12:01:00Z'));

    expect(process).toHaveBeenCalledTimes(1);
    expect(prisma.webhookInboxRows[0].status).toBe('processed');
  });

  it('records failure stage and leaves transient work retryable', async () => {
    const service = new SnapTradeWebhookInboxService(
      prisma as never,
      {
        process: jest.fn(async () => Promise.reject(new Error('database unavailable'))),
      } as unknown as SnapTradeWebhookProcessorService,
    );
    await service.enqueue(input());

    await service.processDue();

    expect(prisma.webhookInboxRows[0]).toMatchObject({
      status: 'retry',
      attempts: 1,
      failureStage: 'dispatch',
      lastError: 'database unavailable',
    });
  });

  it('dead-letters a poison webhook after the bounded retry budget', async () => {
    const process = jest.fn(async () => Promise.reject(new Error('ambiguous account scope')));
    const service = new SnapTradeWebhookInboxService(
      prisma as never,
      { process } as unknown as SnapTradeWebhookProcessorService,
    );
    await service.enqueue(input());
    const firstAttemptAt = prisma.webhookInboxRows[0].nextAttemptAt.getTime() + 1;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await service.processDue(new Date(firstAttemptAt + attempt * 60 * 60_000));
    }

    expect(process).toHaveBeenCalledTimes(8);
    expect(prisma.webhookInboxRows[0]).toMatchObject({
      status: 'dead',
      attempts: 8,
      failureStage: 'dispatch',
      lastError: 'ambiguous account scope',
    });
  });

  it('renews the lease while a slow processor is still in flight', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-05T12:00:00Z'));
    let release: (() => void) | undefined;
    const process = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const service = new SnapTradeWebhookInboxService(
      prisma as never,
      { process } as unknown as SnapTradeWebhookProcessorService,
    );
    try {
      await service.enqueue(input());
      const draining = service.processDue();
      for (let turn = 0; turn < 10 && process.mock.calls.length === 0; turn += 1) {
        await Promise.resolve();
      }
      expect(process).toHaveBeenCalledTimes(1);
      const firstExpiry = prisma.webhookInboxRows[0].leaseExpiresAt.getTime();

      await jest.advanceTimersByTimeAsync(10_001);

      expect(prisma.webhookInboxRows[0].leaseExpiresAt.getTime()).toBeGreaterThan(firstExpiry);
      release?.();
      await draining;
      expect(prisma.webhookInboxRows[0].status).toBe('processed');
    } finally {
      release?.();
      jest.useRealTimers();
    }
  });
});
