import { ChartOrder, OrderResult } from '@0dtetrader/shared-types';
import { OrderEventsService } from '../broker/order-events.service';
import { ChartOrderEventsService } from '../chart-orders/chart-order-events.service';
import { InMemoryPrismaService } from '../../test/in-memory-prisma.service';
import { ApnsClient, ApnsSendResult } from './apns.client';
import { DevicesService } from './devices.service';
import { OrderNotificationsService } from './order-notifications.service';

const TOKEN = 'a'.repeat(64);

function orderResult(overrides: Partial<OrderResult> = {}): OrderResult {
  return {
    orderId: 'O-1',
    status: 'filled',
    contractSymbol: 'SPY260717C00505000',
    side: 'buy',
    quantity: 2,
    orderType: 'mid',
    filledPrice: 1.23,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function chartOrder(overrides: Partial<ChartOrder> = {}): ChartOrder {
  return {
    id: 'line-1',
    underlying: 'SPY',
    triggerPrice: 505,
    armPrice: 504,
    side: 'sell',
    quantity: 1,
    orderType: 'mid',
    kind: 'limit',
    optionType: 'call',
    expiration: '2026-07-17',
    strike: 505,
    contractSymbol: 'SPY260717C00505000',
    ocoGroupId: null,
    status: 'triggered',
    createdAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
    triggeredAt: new Date().toISOString(),
    brokerOrderId: null,
    lastError: null,
    ...overrides,
  };
}

class FakeApns {
  enabled = true;
  sent: { token: string; title: string; body: string }[] = [];
  nextResult: ApnsSendResult = { status: 200 };
  /** Per-send results, consumed in order, for the multi-device cases. */
  queued: ApnsSendResult[] = [];

  async send(token: string, alert: { title: string; body: string }): Promise<ApnsSendResult> {
    this.sent.push({ token, title: alert.title, body: alert.body });
    return this.queued.shift() ?? this.nextResult;
  }
}

describe('OrderNotificationsService', () => {
  let prisma: InMemoryPrismaService;
  let apns: FakeApns;
  let orderEvents: OrderEventsService;
  let chartOrderEvents: ChartOrderEventsService;
  let service: OrderNotificationsService;
  let userId: string;

  beforeEach(async () => {
    prisma = new InMemoryPrismaService();
    apns = new FakeApns();
    orderEvents = new OrderEventsService();
    chartOrderEvents = new ChartOrderEventsService();
    const devices = new DevicesService(prisma as never);
    service = new OrderNotificationsService(
      prisma as never,
      devices,
      apns as unknown as ApnsClient,
      orderEvents,
      chartOrderEvents,
    );
    const user = await prisma.user.create({
      data: { email: 'push@example.com', passwordHash: 'x' },
    });
    userId = user.id;
    await devices.register(userId, TOKEN, 'ios');
  });

  afterEach(() => service.onModuleDestroy());

  it('pushes terminal order statuses, not submitted', async () => {
    await service.handleOrderUpdate(userId, orderResult({ status: 'submitted' }));
    expect(apns.sent).toHaveLength(0);

    await service.handleOrderUpdate(userId, orderResult());
    expect(apns.sent).toHaveLength(1);
    expect(apns.sent[0]).toEqual({
      token: TOKEN,
      title: 'Order filled',
      body: 'BUY 2 SPY260717C00505000 @ 1.23',
    });
  });

  it('does not collapse the same external order id across broker accounts', async () => {
    const order = orderResult();
    await service.handleOrderUpdate(userId, order, 'live', {
      provider: 'snaptrade',
      accountId: 'account-a',
      brokerOrderId: order.orderId,
    });
    await service.handleOrderUpdate(userId, order, 'live', {
      provider: 'snaptrade',
      accountId: 'account-b',
      brokerOrderId: order.orderId,
    });

    expect(apns.sent).toHaveLength(2);
    expect(prisma.pushDeliveries).toHaveLength(2);
  });

  it('prefixes practice-mode pushes (current mode as the fallback when no row exists yet)', async () => {
    prisma.users.find((u) => u.id === userId).tradingMode = 'practice';
    await service.handleOrderUpdate(userId, orderResult({ status: 'rejected' }));
    expect(apns.sent[0].title).toBe('PRACTICE · Order rejected');
  });

  it("labels by the order's recorded environment, not the user's current mode", async () => {
    // A practice order… pushed after the user switched to live.
    prisma.tradeOrders.push({
      id: 'O-1',
      userId,
      environment: 'practice',
      contractSymbol: 'SPY260717C00505000',
      placedAt: new Date(),
    });
    prisma.users.find((u) => u.id === userId).tradingMode = 'live';

    await service.handleOrderUpdate(userId, orderResult());

    expect(apns.sent[0].title).toBe('PRACTICE · Order filled');
  });

  it('a live order stays unprefixed even while the user sits in practice mode', async () => {
    prisma.tradeOrders.push({
      id: 'O-1',
      userId,
      environment: 'live',
      contractSymbol: 'SPY260717C00505000',
      placedAt: new Date(),
    });
    prisma.users.find((u) => u.id === userId).tradingMode = 'practice';

    await service.handleOrderUpdate(userId, orderResult());

    expect(apns.sent[0].title).toBe('Order filled');
  });

  it("chart-order pushes wear the line's recorded environment", async () => {
    prisma.chartOrders.push({ id: 'line-1', userId, environment: 'practice' });
    prisma.users.find((u) => u.id === userId).tradingMode = 'live';

    await service.handleChartOrder(userId, chartOrder());

    expect(apns.sent[0].title).toBe('PRACTICE · Chart order fired');
  });

  it('prunes a token APNs reports dead', async () => {
    apns.nextResult = { status: 410, reason: 'Unregistered' };
    await service.handleOrderUpdate(userId, orderResult());
    expect(prisma.deviceTokens).toHaveLength(0);

    // Pruned means the next event has nowhere to go — and does not throw.
    // A DIFFERENT order, so this isolates pruning rather than also passing
    // on the delivery claim.
    await service.handleOrderUpdate(userId, orderResult({ orderId: 'O-2' }));
    expect(apns.sent).toHaveLength(1);
  });

  it('keeps the token on transient failures', async () => {
    apns.nextResult = { status: 500, reason: 'InternalServerError' };
    await service.handleOrderUpdate(userId, orderResult());
    expect(prisma.deviceTokens).toHaveLength(1);
  });

  it('pushes chart-order fires and failures, nothing else', async () => {
    await service.handleChartOrder(userId, chartOrder({ status: 'working' }));
    await service.handleChartOrder(userId, chartOrder({ status: 'filled' }));
    expect(apns.sent).toHaveLength(0);

    await service.handleChartOrder(userId, chartOrder());
    expect(apns.sent).toHaveLength(1);
    expect(apns.sent[0].title).toBe('Chart order fired');
    expect(apns.sent[0].body).toBe('SELL 1 SPY260717C00505000 — SPY crossed 505');

    await service.handleChartOrder(userId, chartOrder({ status: 'failed' }));
    expect(apns.sent[1].title).toBe('Chart order failed');
  });

  it('stays silent when the sender is disabled', async () => {
    apns.enabled = false;
    await service.handleOrderUpdate(userId, orderResult());
    await service.handleChartOrder(userId, chartOrder());
    expect(apns.sent).toHaveLength(0);
  });

  it('rides the order-events bus', async () => {
    orderEvents.emit(userId, orderResult({ status: 'cancelled', filledPrice: undefined }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(apns.sent).toHaveLength(1);
    expect(apns.sent[0].title).toBe('Order cancelled');
    expect(apns.sent[0].body).toBe('BUY 2 SPY260717C00505000');
  });

  describe('delivery dedupe', () => {
    /** A second API instance: its own sender and buses, the same database. */
    const secondInstance = () => {
      const otherApns = new FakeApns();
      const other = new OrderNotificationsService(
        prisma as never,
        new DevicesService(prisma as never),
        otherApns as unknown as ApnsClient,
        new OrderEventsService(),
        new ChartOrderEventsService(),
      );
      return { other, otherApns };
    };

    it('pushes a terminal outcome once, however many times it is reported', async () => {
      await service.handleOrderUpdate(userId, orderResult());
      await service.handleOrderUpdate(userId, orderResult());

      expect(apns.sent).toHaveLength(1);
      expect(prisma.pushDeliveries).toHaveLength(1);
    });

    it('pushes once when two API instances report the same outcome', async () => {
      // The SnapTrade fill arrives as TRADE_UPDATE on one instance and
      // TRADE_DETECTION on another; a cancel served by either instance races
      // the placing instance's poll the same way.
      const { other, otherApns } = secondInstance();
      try {
        await service.handleOrderUpdate(userId, orderResult());
        await other.handleOrderUpdate(userId, orderResult());

        expect(apns.sent.length + otherApns.sent.length).toBe(1);
      } finally {
        other.onModuleDestroy();
      }
    });

    it('still pushes each distinct outcome of the same order', async () => {
      await service.handleOrderUpdate(userId, orderResult({ status: 'rejected' }));
      await service.handleOrderUpdate(userId, orderResult({ status: 'cancelled' }));

      expect(apns.sent.map((s) => s.title)).toEqual(['Order rejected', 'Order cancelled']);
    });

    it('never lets one user’s claim suppress another’s', async () => {
      const otherUser = await prisma.user.create({
        data: { email: 'push2@example.com', passwordHash: 'x' },
      });
      await new DevicesService(prisma as never).register(otherUser.id, 'b'.repeat(64), 'ios');

      await service.handleOrderUpdate(userId, orderResult());
      await service.handleOrderUpdate(otherUser.id, orderResult());

      expect(apns.sent).toHaveLength(2);
    });

    it('deduplicates a chart line’s fire but not its later failure', async () => {
      await service.handleChartOrder(userId, chartOrder());
      await service.handleChartOrder(userId, chartOrder());
      await service.handleChartOrder(userId, chartOrder({ status: 'failed' }));

      expect(apns.sent.map((s) => s.title)).toEqual(['Chart order fired', 'Chart order failed']);
    });

    it('keeps a failed device due for retry without re-enqueuing siblings', async () => {
      apns.nextResult = { status: 500, reason: 'InternalServerError' };
      await service.handleOrderUpdate(userId, orderResult());
      expect(apns.sent).toHaveLength(1);
      expect(prisma.pushDeliveries).toHaveLength(1);
      expect(prisma.pushDeliveries[0].status).toBe('retry');

      apns.nextResult = { status: 200 };
      await service.processDue(new Date(prisma.pushDeliveries[0].nextAttemptAt.getTime() + 1));
      expect(apns.sent).toHaveLength(2);
      expect(prisma.pushDeliveries).toHaveLength(1);
      expect(prisma.pushDeliveries[0].status).toBe('delivered');
    });

    it('keeps the claim when a device already took the alert', async () => {
      await new DevicesService(prisma as never).register(userId, 'c'.repeat(64), 'ios');
      // First device accepts, second fails: the alert IS on a screen, so a
      // redelivery must not put it there twice.
      apns.queued = [{ status: 200 }, { status: 500, reason: 'InternalServerError' }];
      await service.handleOrderUpdate(userId, orderResult());
      expect(apns.sent).toHaveLength(2);

      await service.handleOrderUpdate(userId, orderResult());
      expect(apns.sent).toHaveLength(2);
    });

    it('gives each event with no order id its own durable identity', async () => {
      // SnapTrade can report a trade update with no brokerage order id. One
      // such event must not claim a key that suppresses every later one.
      await service.handleOrderUpdate(userId, orderResult({ orderId: '' }));
      await service.handleOrderUpdate(userId, orderResult({ orderId: '' }));

      expect(apns.sent).toHaveLength(2);
      expect(prisma.pushDeliveries).toHaveLength(2);
      expect(new Set(prisma.pushDeliveries.map((row) => row.key)).size).toBe(2);
    });

    it('records dead per-device outcomes even with prune failures', async () => {
      // Every device is dead and the prunes fail on top: cleanup trouble
      // must neither keep the claim (nothing was delivered) nor escape as a
      // throw.
      await new DevicesService(prisma as never).register(userId, 'd'.repeat(64), 'ios');
      apns.queued = [
        { status: 410, reason: 'Unregistered' },
        { status: 410, reason: 'Unregistered' },
      ];
      const deleteMany = prisma.deviceToken.deleteMany;
      prisma.deviceToken.deleteMany = async () => {
        throw new Error('connection reset');
      };

      await service.handleOrderUpdate(userId, orderResult());
      expect(prisma.pushDeliveries).toHaveLength(2);
      expect(prisma.pushDeliveries.every((row) => row.status === 'dead')).toBe(true);
      prisma.deviceToken.deleteMany = deleteMany;
    });

    it('keeps the claim when one device delivered and a dead sibling’s prune failed', async () => {
      // Aggregate success is decided from every result BEFORE cleanup: a
      // throwing prune must not erase the fact that device two already
      // showed the alert — releasing here would alert it twice on the other
      // emitter's redelivery.
      await new DevicesService(prisma as never).register(userId, 'e'.repeat(64), 'ios');
      apns.queued = [{ status: 410, reason: 'Unregistered' }, { status: 200 }];
      const deleteMany = prisma.deviceToken.deleteMany;
      prisma.deviceToken.deleteMany = async () => {
        throw new Error('connection reset');
      };

      await service.handleOrderUpdate(userId, orderResult());
      expect(prisma.pushDeliveries).toHaveLength(2);
      expect(prisma.pushDeliveries.map((row) => row.status).sort()).toEqual(['dead', 'delivered']);

      prisma.deviceToken.deleteMany = deleteMany;
      const sends = apns.sent.length;
      await service.handleOrderUpdate(userId, orderResult());
      expect(apns.sent).toHaveLength(sends);
    });

    it('prefers the emitter’s verified environment over the row and the user’s mode', async () => {
      // The race: a LIVE fill arrives while the user sits in practice mode
      // and the order row is not yet visible. The event's own environment —
      // resolved from the credential the webhook was signed with — must
      // decide the label.
      prisma.users.find((u) => u.id === userId).tradingMode = 'practice';

      await service.handleOrderUpdate(userId, orderResult(), 'live');

      expect(apns.sent[0].title).toBe('Order filled');
    });

    it('claims nothing when the user has no device, so registering later still delivers', async () => {
      prisma.deviceTokens.length = 0;
      await service.handleOrderUpdate(userId, orderResult());
      expect(prisma.pushDeliveries).toHaveLength(0);

      await new DevicesService(prisma as never).register(userId, TOKEN, 'ios');
      await service.handleOrderUpdate(userId, orderResult());
      expect(apns.sent).toHaveLength(1);
    });

    it('recovers a per-device lease after the claiming process dies', async () => {
      const row = await prisma.pushDelivery.create({
        data: {
          userId,
          key: 'order:crash:filled',
          deviceToken: TOKEN,
          environment: 'live',
          title: 'Order filled',
          body: 'Recovered delivery',
        },
      });
      Object.assign(row, {
        status: 'leased',
        leaseOwnerId: 'dead-instance',
        leaseExpiresAt: new Date('2026-08-05T12:00:00Z'),
      });

      await service.processDue(new Date('2026-08-05T12:01:00Z'));

      expect(apns.sent[apns.sent.length - 1]?.body).toBe('Recovered delivery');
      expect(row.status).toBe('delivered');
    });

    it('sweeps terminal delivery rows older than seven days under a daily lease', async () => {
      const row = await prisma.pushDelivery.create({
        data: {
          userId,
          key: 'order:old:filled',
          deviceToken: TOKEN,
          environment: 'live',
          title: 'Old',
          body: 'Old',
        },
      });
      Object.assign(row, {
        status: 'delivered',
        createdAt: new Date('2026-07-01T00:00:00Z'),
      });

      await service.processDue(new Date('2026-08-05T12:00:00Z'));

      expect(prisma.pushDeliveries).toHaveLength(0);
      expect(prisma.scheduledJobLeases[0].name).toBe('push-delivery-retention:2026-08-05');
    });

    it('keeps recent terminal rows and old retryable rows inside the dedupe window', async () => {
      const now = new Date('2026-08-05T12:00:00Z');
      const recent = await prisma.pushDelivery.create({
        data: {
          userId,
          key: 'order:recent:filled',
          deviceToken: TOKEN,
          environment: 'live',
          title: 'Recent',
          body: 'Recent',
        },
      });
      Object.assign(recent, {
        status: 'delivered',
        createdAt: new Date(now.getTime() - 6 * 24 * 60 * 60_000),
      });
      const retryable = await prisma.pushDelivery.create({
        data: {
          userId,
          key: 'order:old:retry',
          deviceToken: 'b'.repeat(64),
          environment: 'live',
          title: 'Retry',
          body: 'Retry',
        },
      });
      Object.assign(retryable, {
        status: 'retry',
        createdAt: new Date('2026-07-01T00:00:00Z'),
        nextAttemptAt: new Date('2026-08-06T00:00:00Z'),
      });

      await service.processDue(now);

      expect(prisma.pushDeliveries.map((row) => row.key).sort()).toEqual([
        'order:old:retry',
        'order:recent:filled',
      ]);
    });

    it('retries the same daily retention lease after a failed sweep', async () => {
      const now = new Date('2026-08-05T12:00:00Z');
      const remove = jest
        .spyOn(prisma.pushDelivery, 'deleteMany')
        .mockRejectedValueOnce(new Error('database unavailable'));

      await expect(service.processDue(now)).rejects.toThrow('database unavailable');
      expect(prisma.scheduledJobLeases[0].expiresAt).toEqual(now);

      await service.processDue(new Date(now.getTime() + 1));
      expect(remove).toHaveBeenCalledTimes(2);
    });

    it('runs retention even when APNs delivery is disabled', async () => {
      const row = await prisma.pushDelivery.create({
        data: {
          userId,
          key: 'order:disabled:old',
          deviceToken: TOKEN,
          environment: 'live',
          title: 'Old',
          body: 'Old',
        },
      });
      Object.assign(row, {
        status: 'delivered',
        createdAt: new Date('2026-07-01T00:00:00Z'),
      });
      Object.defineProperty(apns, 'enabled', { value: false });

      await service.processDue(new Date('2026-08-05T12:00:00Z'));

      expect(prisma.pushDeliveries).toHaveLength(0);
      expect(apns.sent).toHaveLength(0);
    });

    it('bounds each account to its ten most recently registered devices', async () => {
      const devices = new DevicesService(prisma as never);
      for (let index = 0; index < 12; index += 1) {
        await devices.register(userId, index.toString(16).padStart(64, '0'), 'ios');
      }
      expect(await devices.listForUser(userId)).toHaveLength(10);
      const tokens = (await devices.listForUser(userId)).map((device) => device.token);
      expect(tokens).not.toContain('0'.repeat(64));
      expect(tokens).not.toContain('0'.repeat(63) + '1');
      expect(tokens).toContain('0'.repeat(63) + 'b');
    });
  });
});
