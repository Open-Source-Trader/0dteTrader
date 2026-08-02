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

  async send(token: string, alert: { title: string; body: string }): Promise<ApnsSendResult> {
    this.sent.push({ token, title: alert.title, body: alert.body });
    return this.nextResult;
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

  it('prefixes practice-mode pushes', async () => {
    prisma.users.find((u) => u.id === userId).tradingMode = 'practice';
    await service.handleOrderUpdate(userId, orderResult({ status: 'rejected' }));
    expect(apns.sent[0].title).toBe('PRACTICE · Order rejected');
  });

  it('prunes a token APNs reports dead', async () => {
    apns.nextResult = { status: 410, reason: 'Unregistered' };
    await service.handleOrderUpdate(userId, orderResult());
    expect(prisma.deviceTokens).toHaveLength(0);

    // Pruned means the next event has nowhere to go — and does not throw.
    await service.handleOrderUpdate(userId, orderResult());
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
});
