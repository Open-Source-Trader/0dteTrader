import { ChartOrderKind, OrderSide, OrderType } from '@0dtetrader/shared-types';
import { InMemoryPrismaService } from '../../test/in-memory-prisma.service';
import { StubBrokerGateway } from '../../test/stub-broker.gateway';
import { BrokerGateway } from '../broker/broker-gateway.interface';
import { OrderEventsService } from '../broker/order-events.service';
import { optionExpirations, optionSettlementAt } from '../broker/expiration-calendar';
import { OrdersService } from '../trading/orders.service';
import { TradingService } from '../trading/trading.service';
import { ChartOrderEventsService } from './chart-order-events.service';
import { ChartOrdersService, MAX_WORKING_CHART_ORDERS } from './chart-orders.service';
import { CreateChartOrderDto } from './dto/chart-order.dto';

/**
 * Nearest expiration that has not settled yet. Run after today's close, the
 * first listed expiration is already dead and the service correctly refuses to
 * arm against it — so the suite must not hard-code `expirations[0]`.
 */
const NEAREST = () =>
  optionExpirations('SPY', new Date()).find(
    (expiration) => optionSettlementAt(expiration, 'SPY').getTime() > Date.now(),
  )!;

function draft(overrides: Partial<CreateChartOrderDto> = {}): CreateChartOrderDto {
  return {
    underlying: 'SPY',
    // The stub quotes SPY at 100, so a trigger at 98 arms from above.
    triggerPrice: 98,
    side: 'buy' as OrderSide,
    quantity: 1,
    orderType: 'mid' as OrderType,
    kind: 'limit' as ChartOrderKind,
    optionType: 'call',
    expiration: NEAREST(),
    strike: 101,
    ...overrides,
  } as CreateChartOrderDto;
}

describe('ChartOrdersService', () => {
  let prisma: InMemoryPrismaService;
  let gateway: StubBrokerGateway;
  let service: ChartOrdersService;
  let userId: string;

  beforeEach(async () => {
    prisma = new InMemoryPrismaService();
    gateway = new StubBrokerGateway();
    const orders = new OrdersService(
      prisma as unknown as ConstructorParameters<typeof OrdersService>[0],
      new OrderEventsService(),
    );
    service = new ChartOrdersService(
      prisma as unknown as ConstructorParameters<typeof ChartOrdersService>[0],
      gateway as BrokerGateway,
      new TradingService(
        prisma as unknown as ConstructorParameters<typeof TradingService>[0],
        gateway as BrokerGateway,
        orders,
      ),
      new ChartOrderEventsService(),
    );
    const user = await prisma.user.create({
      data: { email: 'chart@example.com', passwordHash: 'x' },
    });
    userId = user.id as string;
  });

  describe('create', () => {
    it('arms from the live quote and resolves the contract server-side', async () => {
      const order = await service.create(userId, draft());

      expect(order.status).toBe('working');
      expect(order.armPrice).toBe(StubBrokerGateway.PRICE);
      expect(order.triggerPrice).toBe(98);
      // Armed above the trigger: it fires on the way DOWN through 98.
      expect(order.contractSymbol).toContain('SPY');
      expect(order.strike).toBe(101);
      expect(order.expiresAt.length).toBeGreaterThan(0);
    });

    it('refuses a trigger sitting exactly on the current price, which has no side to cross from', async () => {
      await expect(
        service.create(userId, draft({ triggerPrice: StubBrokerGateway.PRICE })),
      ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    });

    it('rejects a strike that does not exist on the chain', async () => {
      await expect(service.create(userId, draft({ strike: 9_999 }))).rejects.toMatchObject({
        status: 400,
        code: 'VALIDATION_ERROR',
      });
    });

    it('refuses to arm while the kill switch is on', async () => {
      prisma.setTradingDisabled(userId, true);

      await expect(service.create(userId, draft())).rejects.toMatchObject({
        status: 403,
        code: 'TRADING_DISABLED',
      });
    });

    it('caps working orders per user', async () => {
      for (let i = 0; i < MAX_WORKING_CHART_ORDERS; i++) {
        await service.create(userId, draft({ triggerPrice: 90 + i * 0.1 }));
      }

      await expect(service.create(userId, draft({ triggerPrice: 97 }))).rejects.toMatchObject({
        status: 400,
        code: 'VALIDATION_ERROR',
      });
    });

    it('frees a cap slot when an order is cancelled', async () => {
      const first = await service.create(userId, draft());
      for (let i = 1; i < MAX_WORKING_CHART_ORDERS; i++) {
        await service.create(userId, draft({ triggerPrice: 90 + i * 0.1 }));
      }
      await service.cancel(userId, first.id);

      await expect(service.create(userId, draft({ triggerPrice: 97 }))).resolves.toBeDefined();
    });

    it('stamps the environment so a practice line cannot fire against live', async () => {
      const practice = await prisma.user.create({
        data: { email: 'p@example.com', passwordHash: 'x', tradingMode: 'practice' },
      });
      await service.create(practice.id as string, draft());

      expect(prisma.chartOrders[0].environment).toBe('practice');
      // Flipped to live, the practice line is no longer listed.
      prisma.users.find((u) => u.id === practice.id).tradingMode = 'live';
      expect(await service.list(practice.id as string)).toEqual([]);
    });
  });

  describe('update', () => {
    it('re-arms from the live quote when the line is moved', async () => {
      const order = await service.create(userId, draft({ triggerPrice: 98 }));
      gateway.price = 105;

      const moved = await service.update(userId, order.id, { triggerPrice: 110 });

      expect(moved.triggerPrice).toBe(110);
      // Without re-arming, the stale armPrice of 100 would sit BELOW the new
      // trigger and the line would fire on the next tick upward.
      expect(moved.armPrice).toBe(105);
    });

    it('flips the execution type without touching the arm', async () => {
      const order = await service.create(userId, draft({ orderType: 'mid' }));

      const flipped = await service.update(userId, order.id, { orderType: 'market' });

      expect(flipped.orderType).toBe('market');
      expect(flipped.armPrice).toBe(order.armPrice);
      expect(flipped.triggerPrice).toBe(order.triggerPrice);
    });

    it('refuses to change a line that already fired', async () => {
      const order = await service.create(userId, draft());
      await service.claimForFire(order.id, new Date());

      await expect(service.update(userId, order.id, { orderType: 'market' })).rejects.toMatchObject(
        { status: 409, code: 'CHART_ORDER_NOT_WORKING' },
      );
    });

    it("will not touch another user's line", async () => {
      const order = await service.create(userId, draft());
      const other = await prisma.user.create({
        data: { email: 'other@example.com', passwordHash: 'x' },
      });

      await expect(
        service.update(other.id as string, order.id, { quantity: 5 }),
      ).rejects.toMatchObject({ status: 404, code: 'CHART_ORDER_NOT_FOUND' });
    });
  });

  describe('cancel', () => {
    it('cancels a working line', async () => {
      const order = await service.create(userId, draft());

      await service.cancel(userId, order.id);

      expect((await service.list(userId))[0].status).toBe('cancelled');
    });

    it('refuses to cancel a line that already fired', async () => {
      const order = await service.create(userId, draft());
      await service.claimForFire(order.id, new Date());

      await expect(service.cancel(userId, order.id)).rejects.toMatchObject({
        status: 409,
        code: 'CHART_ORDER_NOT_WORKING',
      });
    });
  });

  describe('triggerNow (client-initiated fire)', () => {
    it('sends the order and records the broker id', async () => {
      const place = jest.spyOn(gateway, 'placeOrder');
      const order = await service.create(userId, draft({ orderType: 'market' }));

      const fired = await service.triggerNow(userId, order.id);

      expect(place).toHaveBeenCalledTimes(1);
      expect(fired.status).toBe('triggered');
      expect(fired.brokerOrderId).toBeTruthy();
    });

    it('is idempotent — triggering twice yields one broker order', async () => {
      const place = jest.spyOn(gateway, 'placeOrder');
      const order = await service.create(userId, draft({ orderType: 'market' }));

      const first = await service.triggerNow(userId, order.id);
      const second = await service.triggerNow(userId, order.id);

      expect(place).toHaveBeenCalledTimes(1);
      expect(second.brokerOrderId).toBe(first.brokerOrderId);
    });

    it('marks the line failed with the reason when the broker refuses', async () => {
      const order = await service.create(userId, draft({ orderType: 'market' }));
      gateway.placeError = new Error('insufficient buying power');

      const fired = await service.triggerNow(userId, order.id);

      expect(fired.status).toBe('failed');
      expect(fired.lastError).toContain('insufficient buying power');
    });

    it('un-claims a line whose environment no longer matches the account mode', async () => {
      // Armed in practice, then the user switches to live: firing would route
      // a practice line through the LIVE gateway. The line must stay armed for
      // practice, exactly as the watcher treats it — not fire, not die.
      const practice = await prisma.user.create({
        data: { email: 'trigger-env@example.com', passwordHash: 'x', tradingMode: 'practice' },
      });
      const practiceId = practice.id as string;
      const order = await service.create(practiceId, draft({ orderType: 'market' }));
      prisma.users.find((u) => u.id === practiceId).tradingMode = 'live';
      const place = jest.spyOn(gateway, 'placeOrder');

      const result = await service.triggerNow(practiceId, order.id);

      expect(place).not.toHaveBeenCalled();
      expect(result.status).toBe('working');
      expect((await service.list(practiceId)).length).toBe(0); // hidden while in live
      prisma.users.find((u) => u.id === practiceId).tradingMode = 'practice';
      expect((await service.list(practiceId))[0].status).toBe('working');
    });

    it('expires a settled line instead of firing it', async () => {
      const order = await service.create(userId, draft({ orderType: 'market' }));
      const place = jest.spyOn(gateway, 'placeOrder');

      const afterSettlement = new Date(Date.parse(order.expiresAt) + 60_000);
      const result = await service.triggerNow(userId, order.id, afterSettlement);

      expect(place).not.toHaveBeenCalled();
      expect(result.status).toBe('expired');
    });

    it('never relabels a broker-accepted order as failed when bookkeeping throws', async () => {
      const order = await service.create(userId, draft({ orderType: 'market' }));
      const place = jest.spyOn(gateway, 'placeOrder');
      // The broker call succeeds; the brokerOrderId write afterwards dies.
      const update = jest
        .spyOn(prisma.chartOrder, 'update')
        .mockRejectedValueOnce(new Error('db connection reset'));

      const result = await service.triggerNow(userId, order.id);
      update.mockRestore();

      expect(place).toHaveBeenCalledTimes(1);
      // A live order shown as FAILED would dismiss locally and orphan its OCO
      // sibling — the one outcome this path must never produce.
      expect(result.status).toBe('triggered');
      expect(result.brokerOrderId).toBeTruthy();
    });

    it('still fires normally when the OCO sibling retirement throws', async () => {
      const groupId = '99999999-2222-3333-4444-555555555555';
      const stop = await service.create(
        userId,
        draft({
          kind: 'stop',
          side: 'sell',
          triggerPrice: 95,
          orderType: 'market',
          ocoGroupId: groupId,
        }),
      );
      const retire = jest
        .spyOn(service, 'cancelSiblings')
        .mockRejectedValueOnce(new Error('db down'));

      const result = await service.triggerNow(userId, stop.id);
      retire.mockRestore();

      expect(result.status).toBe('triggered');
    });

    it("refuses to fire another user's line", async () => {
      const order = await service.create(userId, draft());
      const other = await prisma.user.create({
        data: { email: 'nope@example.com', passwordHash: 'x' },
      });

      await expect(service.triggerNow(other.id as string, order.id)).rejects.toMatchObject({
        status: 404,
        code: 'CHART_ORDER_NOT_FOUND',
      });
    });
  });

  describe('claimForFire', () => {
    it('lets exactly one caller through', async () => {
      const order = await service.create(userId, draft());
      const now = new Date();

      const claims = await Promise.all([
        service.claimForFire(order.id, now),
        service.claimForFire(order.id, now),
        service.claimForFire(order.id, now),
      ]);

      expect(claims.filter(Boolean)).toHaveLength(1);
    });
  });

  describe('OCO', () => {
    it('retires the sibling leg when one fires', async () => {
      const groupId = '11111111-2222-3333-4444-555555555555';
      const target = await service.create(
        userId,
        draft({ kind: 'target', triggerPrice: 105, ocoGroupId: groupId }),
      );
      const stop = await service.create(
        userId,
        draft({ kind: 'stop', triggerPrice: 95, ocoGroupId: groupId }),
      );

      const cancelled = await service.cancelSiblings(groupId, stop.id);

      expect(cancelled).toEqual([target.id]);
      const byId = Object.fromEntries((await service.list(userId)).map((o) => [o.id, o.status]));
      expect(byId[target.id]).toBe('cancelled');
      expect(byId[stop.id]).toBe('working');
    });
  });

  describe('reconciliation', () => {
    it('expires working lines past their settlement', async () => {
      const order = await service.create(userId, draft());
      const afterSettlement = new Date(Date.parse(order.expiresAt) + 1000);

      expect(await service.expireSettled(afterSettlement)).toBe(1);
      expect((await service.list(userId))[0].status).toBe('expired');
    });

    it('cancels a bracket leg whose position is gone, but leaves plain limits alone', async () => {
      const stop = await service.create(userId, draft({ kind: 'stop' }));
      const limit = await service.create(userId, draft({ kind: 'limit', triggerPrice: 97 }));

      const later = new Date(Date.now() + 120_000); // past the orphan grace period
      const cancelled = await service.cancelOrphanedBrackets(userId, 'live', [], later);

      expect(cancelled).toEqual([stop.id]);
      const byId = Object.fromEntries((await service.list(userId)).map((o) => [o.id, o.status]));
      expect(byId[stop.id]).toBe('cancelled');
      expect(byId[limit.id]).toBe('working');
    });

    it('keeps a bracket leg whose position is still open', async () => {
      const stop = await service.create(userId, draft({ kind: 'stop' }));

      const cancelled = await service.cancelOrphanedBrackets(
        userId,
        'live',
        [prisma.chartOrders[0].contractSymbol],
        new Date(Date.now() + 120_000),
      );

      expect(cancelled).toEqual([]);
      expect((await service.list(userId))[0].id).toBe(stop.id);
      expect((await service.list(userId))[0].status).toBe('working');
    });
  });
});
