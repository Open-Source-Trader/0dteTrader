import { ChartOrder, OrderResult } from '@0dtetrader/shared-types';
import { OrderEventsService } from '../broker/order-events.service';
import { ChartOrderEventsService } from '../chart-orders/chart-order-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { InMemoryPrismaService } from '../../test/in-memory-prisma.service';
import { EventBridgeService } from './event-bridge.service';
import { EventTransportService } from './event-transport.service';

describe('EventBridgeService', () => {
  it('uses the persisted internal order id across client/broker alias shapes', async () => {
    const prisma = new InMemoryPrismaService();
    const userId = '11111111-1111-4111-8111-111111111111';
    prisma.tradeOrders.push({
      id: '22222222-2222-4222-8222-222222222222',
      userId,
      provider: 'alpaca',
      environment: 'live',
      accountId: 'default',
      brokerOrderId: 'broker-42',
      clientOrderId: 'client-42',
    });
    const publish = jest.fn().mockResolvedValue({});
    const orderEvents = new OrderEventsService();
    const bridge = new EventBridgeService(
      orderEvents,
      new ChartOrderEventsService(),
      { publish } as unknown as EventTransportService,
      prisma as unknown as PrismaService,
    );
    const base: Omit<OrderResult, 'orderId'> = {
      status: 'filled',
      contractSymbol: 'SPY260805C00600000',
      side: 'buy',
      quantity: 1,
      orderType: 'market',
      filledQuantity: 1,
      filledPrice: 1.25,
      timestamp: '2026-08-05T14:30:00.000Z',
    };

    await orderEvents.ingest(userId, { ...base, orderId: 'client-42' }, 'live', {
      provider: 'alpaca',
      accountId: 'default',
      clientOrderId: 'client-42',
      brokerOrderId: 'broker-42',
    });
    await orderEvents.ingest(userId, { ...base, orderId: 'broker-42' }, 'live', {
      provider: 'alpaca',
      accountId: 'default',
      brokerOrderId: 'broker-42',
    });

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0][3]).toBe(
      'order:22222222-2222-4222-8222-222222222222:filled:1:1.25:',
    );
    expect(publish.mock.calls[1][3]).toBe(publish.mock.calls[0][3]);
    bridge.onModuleDestroy();
  });

  it('does not suppress consecutive mutable working chart updates', async () => {
    const prisma = new InMemoryPrismaService();
    const publish = jest.fn().mockResolvedValue({});
    const chartEvents = new ChartOrderEventsService();
    const bridge = new EventBridgeService(
      new OrderEventsService(),
      chartEvents,
      { publish } as unknown as EventTransportService,
      prisma as unknown as PrismaService,
    );
    const base: ChartOrder = {
      id: '33333333-3333-4333-8333-333333333333',
      underlying: 'SPY',
      triggerPrice: 600,
      armPrice: 601,
      side: 'sell',
      quantity: 1,
      orderType: 'mid',
      kind: 'stop',
      optionType: 'call',
      expiration: '2026-08-05',
      strike: 600,
      contractSymbol: 'SPY260805C00600000',
      ocoGroupId: null,
      status: 'working',
      createdAt: '2026-08-05T14:00:00.000Z',
      expiresAt: '2026-08-05T20:00:00.000Z',
      triggeredAt: null,
      brokerOrderId: null,
      lastError: null,
    };

    chartEvents.emit('11111111-1111-4111-8111-111111111111', base);
    chartEvents.emit('11111111-1111-4111-8111-111111111111', {
      ...base,
      quantity: 2,
      triggerPrice: 599.5,
      armPrice: 601.25,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0][3]).not.toBe(publish.mock.calls[1][3]);
    expect(publish.mock.calls[0][3]).toMatch(/^chart:33333333-.+:[a-f0-9]{64}$/);
    bridge.onModuleDestroy();
  });
});
