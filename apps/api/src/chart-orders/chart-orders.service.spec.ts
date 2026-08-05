import { ConfigService } from '@nestjs/config';
import { ChartOrder, ChartOrderKind, OrderSide, OrderType } from '@0dtetrader/shared-types';
import { InMemoryPrismaService } from '../../test/in-memory-prisma.service';
import { StubBrokerGateway } from '../../test/stub-broker.gateway';
import { BrokerGateway } from '../broker/broker-gateway.interface';
import { OrderEventsService } from '../broker/order-events.service';
import { optionExpirations, optionSettlementAt } from '../broker/expiration-calendar';
import { brokerErrors } from '../common/broker-error';
import { OrdersService } from '../trading/orders.service';
import { TradingService } from '../trading/trading.service';
import { ChartOrderEventsService } from './chart-order-events.service';
import {
  ChartOrdersService,
  MAX_WORKING_CHART_ORDERS,
  idempotencyKeyFor,
} from './chart-orders.service';
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
  let chartEvents: ChartOrderEventsService;
  let userId: string;

  beforeEach(async () => {
    prisma = new InMemoryPrismaService();
    gateway = new StubBrokerGateway();
    const orderEvents = new OrderEventsService();
    const orders = new OrdersService(
      prisma as unknown as ConstructorParameters<typeof OrdersService>[0],
      orderEvents,
      gateway as BrokerGateway,
    );
    chartEvents = new ChartOrderEventsService();
    service = new ChartOrdersService(
      prisma as unknown as ConstructorParameters<typeof ChartOrdersService>[0],
      gateway as BrokerGateway,
      new TradingService(
        prisma as unknown as ConstructorParameters<typeof TradingService>[0],
        gateway as BrokerGateway,
        orders,
        orderEvents,
      ),
      chartEvents,
      {
        get: (key: string) => (key === 'chartOrders.staleQuoteMs' ? 10_000 : undefined),
      } as unknown as ConfigService,
    );
    const user = await prisma.user.create({
      data: { email: 'chart@example.com', passwordHash: 'x' },
    });
    userId = user.id as string;
    prisma.acceptCurrentTradingLegal(userId);
  });

  /**
   * Fires a line the way the server now requires.
   *
   * `triggerNow` re-derives the crossing from the server's own quote instead of
   * trusting the client, so the stub has to actually be past the level — one
   * point beyond it, on the far side from where the line armed. The price is
   * restored afterwards because the stub builds its option chain around it.
   */
  async function triggerCrossed(user: string, order: ChartOrder, now?: Date) {
    if (order.kind === 'target' || order.kind === 'stop') {
      gateway.setPosition(
        user,
        order.contractSymbol,
        order.side === 'sell' ? order.quantity : -order.quantity,
      );
    }
    const before = gateway.price;
    gateway.price =
      order.armPrice >= order.triggerPrice
        ? order.triggerPrice - 1 // armed above: crosses on the way down
        : order.triggerPrice + 1; // armed below: crosses on the way up
    try {
      return await service.triggerNow(user, order.id, now);
    } finally {
      gateway.price = before;
    }
  }

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

    it('gives a one-leg protective order an immutable scoped group when clients omit one', async () => {
      const stop = await service.create(
        userId,
        draft({ kind: 'stop', side: 'sell', triggerPrice: 95 }),
      );

      expect(stop.ocoGroupId).toMatch(/^[0-9a-f-]{36}$/);
      expect(prisma.bracketGroups).toContainEqual(
        expect.objectContaining({
          id: stop.ocoGroupId,
          userId,
          provider: 'webull',
          environment: 'live',
          accountId: 'default',
          contractSymbol: stop.contractSymbol,
          closeSide: 'sell',
          status: 'working',
        }),
      );
    });

    it('rejects a standalone limit that tries to join a protective bracket', async () => {
      await expect(
        service.create(
          userId,
          draft({
            kind: 'limit',
            ocoGroupId: '11111111-2222-3333-4444-555555555555',
          }),
        ),
      ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
      expect(prisma.bracketGroups).toHaveLength(0);
      expect(prisma.chartOrders).toHaveLength(0);
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

    it('refuses to arm until the current legal documents are accepted', async () => {
      prisma.legalAcceptances.length = 0;

      await expect(service.create(userId, draft())).rejects.toMatchObject({
        status: 403,
        code: 'LEGAL_ACCEPTANCE_REQUIRED',
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
      prisma.acceptCurrentTradingLegal(practice.id as string);
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

    it('returns the persisted resized bracket leg and keeps both siblings equal', async () => {
      const groupId = '10101010-2222-3333-4444-555555555555';
      const target = await service.create(
        userId,
        draft({ kind: 'target', quantity: 1, triggerPrice: 105, ocoGroupId: groupId }),
      );
      const stop = await service.create(
        userId,
        draft({ kind: 'stop', quantity: 1, triggerPrice: 95, ocoGroupId: groupId }),
      );

      const resized = await service.update(userId, target.id, { quantity: 2 });

      expect(resized.quantity).toBe(2);
      expect((await service.byId(stop.id))?.quantity).toBe(2);
      expect(prisma.bracketGroups.find((group) => group.id === groupId)?.protectedQuantity).toBe(2);
    });

    it('applies a combined bracket resize/type patch and publishes every resized leg', async () => {
      const groupId = '10101010-2222-3333-4444-777777777777';
      const target = await service.create(
        userId,
        draft({
          kind: 'target',
          quantity: 1,
          triggerPrice: 105,
          orderType: 'mid',
          ocoGroupId: groupId,
        }),
      );
      const stop = await service.create(
        userId,
        draft({ kind: 'stop', quantity: 1, triggerPrice: 95, ocoGroupId: groupId }),
      );
      const updates: ChartOrder[] = [];
      const subscription = chartEvents.events$.subscribe((event) => updates.push(event.order));

      const resized = await service.update(userId, target.id, {
        quantity: 2,
        orderType: 'market',
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(resized).toMatchObject({ quantity: 2, orderType: 'market' });
      expect(await service.byId(stop.id)).toMatchObject({ quantity: 2 });
      expect(updates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: target.id, quantity: 2, orderType: 'market' }),
          expect.objectContaining({ id: stop.id, quantity: 2 }),
        ]),
      );
      subscription.unsubscribe();
    });

    it('rolls back the group quantity when a sibling resize write fails', async () => {
      const groupId = '10101010-2222-3333-4444-666666666666';
      const target = await service.create(
        userId,
        draft({ kind: 'target', quantity: 1, triggerPrice: 105, ocoGroupId: groupId }),
      );
      const stop = await service.create(
        userId,
        draft({ kind: 'stop', quantity: 1, triggerPrice: 95, ocoGroupId: groupId }),
      );
      jest.spyOn(prisma.chartOrder, 'updateMany').mockRejectedValueOnce(new Error('write failed'));

      await expect(service.update(userId, target.id, { quantity: 2 })).rejects.toThrow(
        'write failed',
      );

      expect(prisma.bracketGroups.find((group) => group.id === groupId)?.protectedQuantity).toBe(1);
      expect((await service.byId(target.id))?.quantity).toBe(1);
      expect((await service.byId(stop.id))?.quantity).toBe(1);
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

    /**
     * `updatedAt` is load-bearing: the watcher compares it against its last
     * observed price to decide whether to resume from `armPrice`. A patch that
     * changes nothing must therefore not write, or it silently resets that
     * line's crossing test.
     */
    it('does not write for a patch that changes nothing', async () => {
      const order = await service.create(userId, draft({ triggerPrice: 98 }));
      const before = prisma.chartOrders[0].updatedAt;

      const empty = await service.update(userId, order.id, {});
      const sameTrigger = await service.update(userId, order.id, { triggerPrice: 98 });

      expect(empty.triggerPrice).toBe(98);
      expect(sameTrigger.triggerPrice).toBe(98);
      expect(prisma.chartOrders[0].updatedAt).toBe(before);
    });
  });

  describe('cancel', () => {
    it('cancels a working line', async () => {
      const order = await service.create(userId, draft());

      await service.cancel(userId, order.id);

      expect((await service.list(userId))[0].status).toBe('cancelled');
    });

    it('publishes manual create, move, and cancel mutations to other clients', async () => {
      const updates: ChartOrder[] = [];
      const subscription = chartEvents.events$.subscribe((event) => updates.push(event.order));

      const order = await service.create(userId, draft({ triggerPrice: 98 }));
      await service.update(userId, order.id, { triggerPrice: 97 });
      await service.cancel(userId, order.id);
      await new Promise((resolve) => setImmediate(resolve));

      expect(updates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: order.id, status: 'working', triggerPrice: 98 }),
          expect.objectContaining({ id: order.id, status: 'working', triggerPrice: 97 }),
          expect.objectContaining({ id: order.id, status: 'cancelled' }),
        ]),
      );
      subscription.unsubscribe();
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

      const fired = await triggerCrossed(userId, order);

      expect(place).toHaveBeenCalledTimes(1);
      expect(fired.status).toBe('triggered');
      expect(fired.brokerOrderId).toBeTruthy();
    });

    it('is idempotent — triggering twice yields one broker order', async () => {
      const place = jest.spyOn(gateway, 'placeOrder');
      const order = await service.create(userId, draft({ orderType: 'market' }));

      const first = await triggerCrossed(userId, order);
      const second = await triggerCrossed(userId, order);

      expect(place).toHaveBeenCalledTimes(1);
      expect(second.brokerOrderId).toBe(first.brokerOrderId);
    });

    it('marks the line failed with the reason when the broker refuses', async () => {
      const order = await service.create(userId, draft({ orderType: 'market' }));
      gateway.placeError = brokerErrors.insufficientBuyingPower('insufficient buying power');

      const fired = await triggerCrossed(userId, order);

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
      prisma.acceptCurrentTradingLegal(practiceId);
      const order = await service.create(practiceId, draft({ orderType: 'market' }));
      prisma.users.find((u) => u.id === practiceId).tradingMode = 'live';
      const place = jest.spyOn(gateway, 'placeOrder');

      const result = await triggerCrossed(practiceId, order);

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
      const result = await triggerCrossed(userId, order, afterSettlement);

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

      const result = await triggerCrossed(userId, order);
      update.mockRestore();

      expect(place).toHaveBeenCalledTimes(1);
      // A live order shown as FAILED would dismiss locally and orphan its OCO
      // sibling — the one outcome this path must never produce.
      expect(result.status).toBe('triggered');
      expect(result.brokerOrderId).toBeTruthy();
    });

    it('keeps a broker-accepted bracket pending until leg and group finalize atomically', async () => {
      const groupId = '29292929-2222-3333-4444-555555555555';
      await service.create(
        userId,
        draft({ kind: 'target', side: 'sell', triggerPrice: 105, ocoGroupId: groupId }),
      );
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
      const place = jest.spyOn(gateway, 'placeOrder');
      const updateMany = prisma.chartOrder.updateMany.bind(prisma.chartOrder);
      let rejectBrokerIdWrite = true;
      const writes = jest
        .spyOn(prisma.chartOrder, 'updateMany')
        .mockImplementation(async (args) => {
          if (rejectBrokerIdWrite && args.data?.brokerOrderId) {
            rejectBrokerIdWrite = false;
            throw new Error('db connection reset after broker acceptance');
          }
          return updateMany(args);
        });

      const result = await triggerCrossed(userId, stop);

      expect(place).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('pending_fire');
      expect((await service.byId(stop.id))?.brokerOrderId).toBeNull();
      const group = prisma.bracketGroups.find((candidate) => candidate.id === groupId);
      expect(group?.status).toBe('pending_fire');

      writes.mockRestore();
      group.leaseExpiresAt = new Date(Date.now() - 1);
      expect(await service.recoverPendingBrackets(new Date())).toBe(1);
      expect(place).toHaveBeenCalledTimes(1);
      expect((await service.byId(stop.id))?.status).toBe('triggered');
      expect((await service.byId(stop.id))?.brokerOrderId).toBeTruthy();
      expect(group.status).toBe('fired');
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
      const result = await triggerCrossed(userId, stop);

      expect(result.status).toBe('triggered');
    });

    /**
     * Retirement is what makes the claim safe, so a claim that cannot complete
     * it must be given back — a half-claimed group would strand every leg out
     * of `working` with nothing sent and no path back.
     */
    it('gives the whole group back when the retirement write fails', async () => {
      const place = jest.spyOn(gateway, 'placeOrder');
      const groupId = 'aaaaaaaa-2222-3333-4444-555555555555';
      const target = await service.create(
        userId,
        draft({ kind: 'target', triggerPrice: 105, orderType: 'market', ocoGroupId: groupId }),
      );
      const stop = await service.create(
        userId,
        draft({ kind: 'stop', triggerPrice: 95, orderType: 'market', ocoGroupId: groupId }),
      );
      const updateMany = jest.spyOn(prisma.chartOrder, 'updateMany');
      // First call is the claim; make the sibling retirement blow up.
      updateMany.mockImplementationOnce(updateMany.getMockImplementation()!);
      updateMany.mockRejectedValueOnce(new Error('db down'));

      const result = await service.fire((await service.byId(stop.id))!, new Date());
      updateMany.mockRestore();

      expect(place).not.toHaveBeenCalled();
      expect(result.status).not.toBe('triggered');
      expect((await service.byId(stop.id))?.status).toBe('working');
      expect((await service.byId(target.id))?.status).toBe('working');
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

      await triggerCrossed(userId, stop);

      const byId = Object.fromEntries((await service.list(userId)).map((o) => [o.id, o.status]));
      expect(byId[stop.id]).toBe('triggered');
      expect(byId[target.id]).toBe('cancelled');
    });

    /**
     * The whipsaw case: price crosses the target and then the stop inside one
     * broker round-trip, so the client fires both legs concurrently. Claiming
     * per-row let both win and both reach the broker — closing the position and
     * then reversing it into an unintended short.
     */
    it('sends ONE broker order when both legs fire concurrently', async () => {
      const place = jest.spyOn(gateway, 'placeOrder');
      const groupId = '33333333-2222-3333-4444-555555555555';
      const target = await service.create(
        userId,
        draft({ kind: 'target', triggerPrice: 105, orderType: 'market', ocoGroupId: groupId }),
      );
      const stop = await service.create(
        userId,
        draft({ kind: 'stop', triggerPrice: 95, orderType: 'market', ocoGroupId: groupId }),
      );

      // Straight at `fire`, not through `triggerNow`: this test is about the
      // group claim serialising two simultaneous fires, and a target above and
      // a stop below cannot both be crossed by one quote — the client-authority
      // check `triggerNow` now applies would refuse one of them at the door and
      // the legs would never race at all.
      const rows = prisma.chartOrders.filter(
        (row: { ocoGroupId?: string }) => row.ocoGroupId === groupId,
      );
      gateway.setPosition(userId, stop.contractSymbol, -stop.quantity);
      expect(rows.map((row: { id: string }) => row.id).sort()).toEqual([target.id, stop.id].sort());

      const now = new Date();
      const [first, second] = await Promise.all(
        rows.map((row: Parameters<typeof service.fire>[0]) => service.fire(row, now)),
      );

      expect(place).toHaveBeenCalledTimes(1);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual(['cancelled', 'triggered']);
      const byId = Object.fromEntries((await service.list(userId)).map((o) => [o.id, o.status]));
      expect(Object.values(byId).filter((s) => s === 'triggered')).toHaveLength(1);
      expect(Object.values(byId).filter((s) => s === 'cancelled')).toHaveLength(1);
    });

    it('retires the sibling before the broker call, not after it', async () => {
      const groupId = '44444444-2222-3333-4444-555555555555';
      const target = await service.create(
        userId,
        draft({ kind: 'target', triggerPrice: 105, orderType: 'market', ocoGroupId: groupId }),
      );
      const stop = await service.create(
        userId,
        draft({ kind: 'stop', triggerPrice: 95, orderType: 'market', ocoGroupId: groupId }),
      );
      // Observe the sibling's state at the moment the order reaches the broker.
      let siblingStatusAtPlace: string | undefined;
      jest.spyOn(gateway, 'placeOrder').mockImplementationOnce(async () => {
        siblingStatusAtPlace = (await service.byId(target.id))?.status;
        throw brokerErrors.orderRejected('broker refused');
      });

      await triggerCrossed(userId, stop);

      expect(siblingStatusAtPlace).toBe('cancelled');
    });

    /** Nothing was sent, so the bracket must survive intact. */
    it('re-arms the retired sibling when the fire is rejected', async () => {
      const groupId = '55555555-2222-3333-4444-555555555555';
      const target = await service.create(
        userId,
        draft({ kind: 'target', triggerPrice: 105, orderType: 'market', ocoGroupId: groupId }),
      );
      const stop = await service.create(
        userId,
        draft({ kind: 'stop', triggerPrice: 95, orderType: 'market', ocoGroupId: groupId }),
      );
      gateway.placeError = brokerErrors.insufficientBuyingPower();

      const fired = await triggerCrossed(userId, stop);

      expect(fired.status).toBe('failed');
      expect((await service.byId(target.id))?.status).toBe('working');
    });

    it('re-arms the bracket when the pre-send positions check is unavailable', async () => {
      const groupId = '56565656-2222-3333-4444-555555555555';
      const target = await service.create(
        userId,
        draft({ kind: 'target', triggerPrice: 105, orderType: 'market', ocoGroupId: groupId }),
      );
      const stop = await service.create(
        userId,
        draft({ kind: 'stop', triggerPrice: 95, orderType: 'market', ocoGroupId: groupId }),
      );
      jest
        .spyOn(gateway, 'getPositions')
        .mockRejectedValueOnce(brokerErrors.unavailable('positions are offline'));
      const place = jest.spyOn(gateway, 'placeOrder');

      const result = await triggerCrossed(userId, stop);

      expect(place).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
      expect((await service.byId(target.id))?.status).toBe('working');
      expect(prisma.bracketGroups.find((group) => group.id === groupId)?.status).toBe('working');
    });

    /**
     * The environment gate un-claims the leg, but the group claim had already
     * retired its sibling before the gate ran. Nothing was sent, so leaving the
     * sibling `cancelled` would silently unbracket the position — and read to
     * the user as though the other leg had filled.
     */
    it('re-arms the retired sibling when the environment gate un-claims the fire', async () => {
      const practice = await prisma.user.create({
        data: { email: 'oco-env@example.com', passwordHash: 'x', tradingMode: 'practice' },
      });
      const practiceId = practice.id as string;
      prisma.acceptCurrentTradingLegal(practiceId);
      const groupId = '77777777-2222-3333-4444-555555555555';
      const target = await service.create(
        practiceId,
        draft({ kind: 'target', triggerPrice: 105, orderType: 'market', ocoGroupId: groupId }),
      );
      const stop = await service.create(
        practiceId,
        draft({ kind: 'stop', triggerPrice: 95, orderType: 'market', ocoGroupId: groupId }),
      );
      prisma.users.find((u) => u.id === practiceId).tradingMode = 'live';
      const place = jest.spyOn(gateway, 'placeOrder');

      const result = await triggerCrossed(practiceId, stop);

      expect(place).not.toHaveBeenCalled();
      expect(result.status).toBe('working');
      expect((await service.byId(target.id))?.status).toBe('working');
    });

    it('does not route an armed bracket after the selected broker account changes', async () => {
      let accountId = 'account-a';
      (gateway as BrokerGateway).executionScope = jest.fn(async () => ({
        provider: 'webull' as const,
        environment: 'live' as const,
        accountId,
      }));
      const groupId = '78787878-2222-3333-4444-555555555555';
      const target = await service.create(
        userId,
        draft({ kind: 'target', triggerPrice: 105, side: 'sell', ocoGroupId: groupId }),
      );
      const stop = await service.create(
        userId,
        draft({ kind: 'stop', triggerPrice: 95, side: 'sell', ocoGroupId: groupId }),
      );
      accountId = 'account-b';
      const place = jest.spyOn(gateway, 'placeOrder');

      const result = await triggerCrossed(userId, stop);

      expect(place).not.toHaveBeenCalled();
      expect(result.status).toBe('working');
      expect((await service.byId(target.id))?.status).toBe('working');
      expect(prisma.bracketGroups.find((group) => group.id === groupId)?.accountId).toBe(
        'account-a',
      );
    });

    it('pins a one-leg stop to its arm-time account even without a client group id', async () => {
      let accountId = 'account-a';
      (gateway as BrokerGateway).executionScope = jest.fn(async () => ({
        provider: 'webull' as const,
        environment: 'live' as const,
        accountId,
      }));
      const stop = await service.create(
        userId,
        draft({ kind: 'stop', side: 'sell', triggerPrice: 95, orderType: 'market' }),
      );
      accountId = 'account-b';
      const place = jest.spyOn(gateway, 'placeOrder');

      const result = await triggerCrossed(userId, stop);

      expect(place).not.toHaveBeenCalled();
      expect(result.status).toBe('working');
      expect(stop.ocoGroupId).not.toBeNull();
      expect(prisma.bracketGroups.find((group) => group.id === stop.ocoGroupId)?.accountId).toBe(
        'account-a',
      );
    });

    /** A settled contract sends nothing either, so the sibling is not a fill. */
    it('re-arms the retired sibling when the fired leg has already settled', async () => {
      const groupId = '88888888-2222-3333-4444-555555555555';
      const target = await service.create(
        userId,
        draft({ kind: 'target', triggerPrice: 105, orderType: 'market', ocoGroupId: groupId }),
      );
      const stop = await service.create(
        userId,
        draft({ kind: 'stop', triggerPrice: 95, orderType: 'market', ocoGroupId: groupId }),
      );
      const afterSettlement = new Date(Date.parse(stop.expiresAt) + 60_000);

      const result = await triggerCrossed(userId, stop, afterSettlement);

      expect(result.status).toBe('expired');
      // Not `cancelled` — no leg filled. The expiry sweep retires it on its own
      // `expiresAt`, which is what actually ended this bracket.
      expect((await service.byId(target.id))?.status).toBe('working');
      await service.expireSettled(afterSettlement);
      expect((await service.byId(target.id))?.status).toBe('expired');
    });

    /**
     * The claim locks the rows that exist when it runs; a leg inserted after it
     * is a phantom the group claim never saw, and firing it would close the
     * position and then reverse it. The server refuses the join.
     */
    it('refuses to add a leg to a bracket that already fired', async () => {
      const groupId = '77777777-2222-3333-4444-555555555555';
      const stop = await service.create(
        userId,
        draft({ kind: 'stop', triggerPrice: 95, orderType: 'market', ocoGroupId: groupId }),
      );
      await triggerCrossed(userId, stop);

      await expect(
        service.create(
          userId,
          draft({ kind: 'target', triggerPrice: 105, orderType: 'market', ocoGroupId: groupId }),
        ),
      ).rejects.toMatchObject({ status: 409, code: 'OCO_GROUP_CLOSED' });
    });

    it('leaves no working late leg when add and fire race on the same group', async () => {
      const groupId = '77777777-2222-3333-4444-666666666666';
      const target = await service.create(
        userId,
        draft({
          kind: 'target',
          triggerPrice: 105,
          orderType: 'market',
          side: 'sell',
          ocoGroupId: groupId,
        }),
      );

      const [added, fired] = await Promise.allSettled([
        service.create(
          userId,
          draft({
            kind: 'stop',
            triggerPrice: 95,
            orderType: 'market',
            side: 'sell',
            ocoGroupId: groupId,
          }),
        ),
        triggerCrossed(userId, target),
      ]);

      expect(fired.status).toBe('fulfilled');
      expect(['fulfilled', 'rejected']).toContain(added.status);
      expect(prisma.bracketGroups.find((group) => group.id === groupId)?.status).toBe('fired');
      expect(
        prisma.chartOrders.filter((row) => row.ocoGroupId === groupId && row.status === 'working'),
      ).toHaveLength(0);
    });

    it('returns the committed fire state when a watcher claims the new leg immediately after insert', async () => {
      const groupId = '77777777-2222-3333-4444-777777777777';
      const originalTransaction = prisma.$transaction.bind(prisma);
      let injectedFire = false;
      jest.spyOn(prisma, '$transaction').mockImplementation(async (operation) => {
        const result = await originalTransaction(operation);
        if (injectedFire) return result;
        const inserted = prisma.chartOrders.find((candidate) => candidate.ocoGroupId === groupId);
        if (!inserted) return result;

        // Prisma returns detached records. Preserve that stale working snapshot
        // while a watcher claims the durable row before create() resumes.
        const detached = structuredClone(result);
        injectedFire = true;
        gateway.setPosition(userId, inserted.contractSymbol, 1);
        await service.fire(
          inserted as unknown as Parameters<ChartOrdersService['fire']>[0],
          new Date(),
        );
        return detached;
      });

      await expect(
        service.create(
          userId,
          draft({
            kind: 'stop',
            side: 'sell',
            triggerPrice: 95,
            orderType: 'market',
            ocoGroupId: groupId,
          }),
        ),
      ).resolves.toMatchObject({ status: 'triggered', brokerOrderId: expect.any(String) });
      expect(prisma.bracketGroups.find((group) => group.id === groupId)?.status).toBe('fired');
    });

    it('still allows a second leg while the bracket is fully armed', async () => {
      const groupId = '88888888-2222-3333-4444-555555555555';
      await service.create(userId, draft({ kind: 'stop', triggerPrice: 95, ocoGroupId: groupId }));

      await expect(
        service.create(userId, draft({ kind: 'target', triggerPrice: 105, ocoGroupId: groupId })),
      ).resolves.toBeDefined();
    });

    it('canonicalizes different client group ids for the same protected position', async () => {
      const firstGroup = '88888888-2222-3333-4444-111111111111';
      const secondGroup = '88888888-2222-3333-4444-222222222222';
      const target = await service.create(
        userId,
        draft({ kind: 'target', triggerPrice: 105, side: 'sell', ocoGroupId: firstGroup }),
      );
      const stop = await service.create(
        userId,
        draft({ kind: 'stop', triggerPrice: 95, side: 'sell', ocoGroupId: secondGroup }),
      );

      expect(target.ocoGroupId).toBe(firstGroup);
      expect(stop.ocoGroupId).toBe(firstGroup);
      expect(prisma.bracketGroups).toHaveLength(1);
    });

    it.each(['failed', 'cancelled'] as const)(
      'reactivates the durable same-kind leg after it is %s',
      async (terminal) => {
        const groupId =
          terminal === 'failed'
            ? '89898989-2222-3333-4444-111111111111'
            : '89898989-2222-3333-4444-222222222222';
        const original = await service.create(
          userId,
          draft({ kind: 'target', triggerPrice: 105, side: 'sell', ocoGroupId: groupId }),
        );
        if (terminal === 'failed') {
          gateway.setPosition(userId, original.contractSymbol, 1);
          gateway.placeError = brokerErrors.orderRejected('definitive rejection');
          await service.fire((await service.byId(original.id))!, new Date());
          gateway.placeError = null;
        } else {
          await service.create(
            userId,
            draft({ kind: 'stop', triggerPrice: 95, side: 'sell', ocoGroupId: groupId }),
          );
          await service.cancel(userId, original.id);
        }

        const rearmed = await service.create(
          userId,
          draft({ kind: 'target', triggerPrice: 106, side: 'sell', ocoGroupId: groupId }),
        );

        expect(rearmed.id).toBe(original.id);
        expect(rearmed.status).toBe('working');
        expect(rearmed.triggerPrice).toBe(106);
        expect(rearmed.triggeredAt).toBeNull();
        expect(rearmed.brokerOrderId).toBeNull();
        expect(rearmed.lastError).toBeNull();
      },
    );

    it('closes an empty cancelled group so a differently-sized bracket can replace it', async () => {
      const oldGroupId = '8a8a8a8a-2222-3333-4444-111111111111';
      const newGroupId = '8a8a8a8a-2222-3333-4444-222222222222';
      const target = await service.create(
        userId,
        draft({
          kind: 'target',
          side: 'sell',
          quantity: 1,
          triggerPrice: 105,
          ocoGroupId: oldGroupId,
        }),
      );
      const stop = await service.create(
        userId,
        draft({
          kind: 'stop',
          side: 'sell',
          quantity: 1,
          triggerPrice: 95,
          ocoGroupId: oldGroupId,
        }),
      );
      await service.cancel(userId, target.id);
      expect(prisma.bracketGroups.find((group) => group.id === oldGroupId)?.status).toBe('working');
      await service.cancel(userId, stop.id);
      expect(prisma.bracketGroups.find((group) => group.id === oldGroupId)?.status).toBe('closed');

      const replacement = await service.create(
        userId,
        draft({
          kind: 'stop',
          side: 'sell',
          quantity: 2,
          triggerPrice: 94,
          ocoGroupId: newGroupId,
        }),
      );

      expect(replacement.ocoGroupId).toBe(newGroupId);
      expect(replacement.quantity).toBe(2);
      expect(prisma.bracketGroups.find((group) => group.id === newGroupId)?.protectedQuantity).toBe(
        2,
      );
    });

    it('closes an expired empty group instead of canonicalizing new protection into it', async () => {
      const oldGroupId = '8b8b8b8b-2222-3333-4444-111111111111';
      const newGroupId = '8b8b8b8b-2222-3333-4444-222222222222';
      const stop = await service.create(
        userId,
        draft({
          kind: 'stop',
          side: 'sell',
          quantity: 1,
          triggerPrice: 95,
          ocoGroupId: oldGroupId,
        }),
      );
      await service.create(
        userId,
        draft({
          kind: 'target',
          side: 'sell',
          quantity: 1,
          triggerPrice: 105,
          ocoGroupId: oldGroupId,
        }),
      );

      await service.expireSettled(new Date(Date.parse(stop.expiresAt) + 1));
      expect(prisma.bracketGroups.find((group) => group.id === oldGroupId)?.status).toBe('closed');
      await expect(
        service.create(
          userId,
          draft({
            kind: 'stop',
            side: 'sell',
            quantity: 2,
            triggerPrice: 94,
            ocoGroupId: newGroupId,
          }),
        ),
      ).resolves.toMatchObject({ ocoGroupId: newGroupId, quantity: 2 });
    });

    it('closes an orphaned empty group so later protection uses current size', async () => {
      const oldGroupId = '8c8c8c8c-2222-3333-4444-111111111111';
      const newGroupId = '8c8c8c8c-2222-3333-4444-222222222222';
      await service.create(
        userId,
        draft({
          kind: 'stop',
          side: 'sell',
          quantity: 1,
          triggerPrice: 95,
          ocoGroupId: oldGroupId,
        }),
      );
      await service.create(
        userId,
        draft({
          kind: 'target',
          side: 'sell',
          quantity: 1,
          triggerPrice: 105,
          ocoGroupId: oldGroupId,
        }),
      );

      await service.cancelOrphanedBrackets(userId, 'live', [], new Date(Date.now() + 120_000));
      expect(prisma.bracketGroups.find((group) => group.id === oldGroupId)?.status).toBe('closed');
      await expect(
        service.create(
          userId,
          draft({
            kind: 'target',
            side: 'sell',
            quantity: 2,
            triggerPrice: 106,
            ocoGroupId: newGroupId,
          }),
        ),
      ).resolves.toMatchObject({ ocoGroupId: newGroupId, quantity: 2 });
    });

    it('keeps a timed-out close reserved instead of re-arming its sibling', async () => {
      const groupId = '90909090-2222-3333-4444-111111111111';
      const target = await service.create(
        userId,
        draft({ kind: 'target', triggerPrice: 105, side: 'sell', ocoGroupId: groupId }),
      );
      const stop = await service.create(
        userId,
        draft({ kind: 'stop', triggerPrice: 95, side: 'sell', ocoGroupId: groupId }),
      );
      gateway.placeError = brokerErrors.unavailable('request timed out after broker send');

      const result = await triggerCrossed(userId, stop);

      expect(result.status).toBe('pending_fire');
      expect((await service.byId(target.id))?.status).toBe('cancelled');
      expect(prisma.bracketGroups.find((group) => group.id === groupId)?.status).toBe(
        'pending_fire',
      );
      expect(
        prisma.orderAudits.find((audit) => audit.idempotencyKey === idempotencyKeyFor(stop.id))
          ?.status,
      ).toBe('pending');
    });

    it('allows only one close across legacy groups and keeps a submitted close reserved', async () => {
      const firstGroup = '91919191-2222-3333-4444-111111111111';
      const secondGroup = '91919191-2222-3333-4444-222222222222';
      const first = await service.create(
        userId,
        draft({ kind: 'stop', triggerPrice: 95, side: 'sell', ocoGroupId: firstGroup }),
      );
      const firstRow = (await service.byId(first.id))!;
      const group = prisma.bracketGroups.find((candidate) => candidate.id === firstGroup)!;
      await prisma.bracketGroup.create({
        data: {
          id: secondGroup,
          userId,
          provider: group.provider,
          environment: group.environment,
          accountId: group.accountId,
          contractSymbol: group.contractSymbol,
          closeSide: group.closeSide,
          protectedQuantity: group.protectedQuantity,
        },
      });
      const secondRow = await prisma.chartOrder.create({
        data: {
          userId,
          environment: firstRow.environment,
          underlying: firstRow.underlying,
          triggerPrice: 94,
          armPrice: firstRow.armPrice,
          side: firstRow.side,
          quantity: firstRow.quantity,
          orderType: firstRow.orderType,
          kind: firstRow.kind,
          optionType: firstRow.optionType,
          expiration: firstRow.expiration,
          strike: firstRow.strike,
          contractSymbol: firstRow.contractSymbol,
          ocoGroupId: secondGroup,
          status: 'working',
          expiresAt: firstRow.expiresAt,
        },
      });
      gateway.setPosition(userId, first.contractSymbol, 1);
      const place = jest.spyOn(gateway, 'placeOrder');

      const firstResult = await service.fire(firstRow, new Date());
      const secondResult = await service.fire(secondRow, new Date());

      expect(firstResult.status).toBe('triggered');
      expect(secondResult.status).toBe('working');
      expect(place).toHaveBeenCalledTimes(1);
      expect(prisma.bracketGroups.find((candidate) => candidate.id === firstGroup)?.status).toBe(
        'fired',
      );
    });

    it('rolls back a newly-created group when its first leg cannot be inserted', async () => {
      const groupId = '88888888-2222-3333-4444-777777777777';
      jest.spyOn(prisma.chartOrder, 'create').mockRejectedValueOnce(new Error('write failed'));

      await expect(
        service.create(userId, draft({ kind: 'stop', triggerPrice: 95, ocoGroupId: groupId })),
      ).rejects.toThrow('write failed');

      expect(prisma.bracketGroups.some((group) => group.id === groupId)).toBe(false);
      expect(prisma.chartOrders.some((order) => order.ocoGroupId === groupId)).toBe(false);
    });

    /**
     * OCO cancels siblings by group membership, not by kind — two targets (or
     * two stops) sharing a group would silently retire one of them on fire
     * instead of the client's drag-to-move updating the existing leg. Refusing
     * the join is what makes that surface as an error instead of a silent loss.
     */
    it('refuses a second leg of the same kind in one bracket', async () => {
      const groupId = '66666666-2222-3333-4444-555555555555';
      await service.create(
        userId,
        draft({ kind: 'target', triggerPrice: 105, ocoGroupId: groupId }),
      );

      await expect(
        service.create(userId, draft({ kind: 'target', triggerPrice: 106, ocoGroupId: groupId })),
      ).rejects.toMatchObject({ status: 409, code: 'OCO_GROUP_DUPLICATE_KIND' });
    });

    /**
     * The watcher hands the same `now` to every fire in a tick, so the claim
     * mints its own stamp — otherwise a later fire could match an earlier
     * claim's rows by timestamp and retire a leg it never claimed.
     */
    it('keeps claims distinct when two fires share one timestamp', async () => {
      const groupId = '99999999-2222-3333-4444-555555555555';
      const stopA = await service.create(
        userId,
        draft({ kind: 'stop', triggerPrice: 95, orderType: 'market', ocoGroupId: groupId }),
      );
      const targetA = await service.create(
        userId,
        draft({ kind: 'target', triggerPrice: 105, orderType: 'market', ocoGroupId: groupId }),
      );
      gateway.placeError = brokerErrors.orderRejected('broker refused');
      const now = new Date();

      await service.fire((await service.byId(stopA.id))!, now);
      // Same clock value, second fire: must not reach across into the first
      // claim's generation.
      await service.fire((await service.byId(targetA.id))!, now);

      expect((await service.byId(stopA.id))?.status).toBe('failed');
    });

    /** A leg cancelled by hand must not drag its still-armed sibling down. */
    it('does not retire a sibling when the fired leg is no longer working', async () => {
      const place = jest.spyOn(gateway, 'placeOrder');
      const groupId = '66666666-2222-3333-4444-555555555555';
      const target = await service.create(
        userId,
        draft({ kind: 'target', triggerPrice: 105, orderType: 'market', ocoGroupId: groupId }),
      );
      const stop = await service.create(
        userId,
        draft({ kind: 'stop', triggerPrice: 95, orderType: 'market', ocoGroupId: groupId }),
      );
      await service.cancel(userId, stop.id);

      const result = await triggerCrossed(userId, stop);

      expect(place).not.toHaveBeenCalled();
      expect(result.status).toBe('cancelled');
      expect((await service.byId(target.id))?.status).toBe('working');
    });

    it('does not re-arm a manually cancelled sibling when pending-fire recovery is rejected', async () => {
      const groupId = '67676767-2222-3333-4444-555555555555';
      const target = await service.create(
        userId,
        draft({ kind: 'target', triggerPrice: 105, orderType: 'market', ocoGroupId: groupId }),
      );
      const stop = await service.create(
        userId,
        draft({ kind: 'stop', triggerPrice: 95, orderType: 'market', ocoGroupId: groupId }),
      );
      await service.cancel(userId, target.id);
      gateway.placeError = brokerErrors.unavailable('acknowledgement lost');

      expect((await triggerCrossed(userId, stop)).status).toBe('pending_fire');
      const audit = prisma.orderAudits.find(
        (candidate) => candidate.idempotencyKey === idempotencyKeyFor(stop.id),
      )!;
      audit.createdAt = new Date(Date.now() - 3 * 60_000);
      const group = prisma.bracketGroups.find((candidate) => candidate.id === groupId)!;
      group.leaseExpiresAt = new Date(Date.now() - 1);
      (gateway as BrokerGateway).getRecentOrders = jest.fn(async () => []);
      gateway.placeError = brokerErrors.insufficientBuyingPower('still rejected');

      expect(await service.recoverPendingBrackets(new Date())).toBe(0);
      expect((await service.byId(target.id))?.status).toBe('cancelled');
      expect((await service.byId(stop.id))?.status).toBe('failed');
      expect(group.status).toBe('closed');
    });

    it('recovers an accepted standalone fire after a lost acknowledgement without placing twice', async () => {
      const order = await service.create(
        userId,
        draft({ kind: 'limit', side: 'buy', triggerPrice: 98, orderType: 'market' }),
      );
      const place = jest.spyOn(gateway, 'placeOrder');
      gateway.placeError = brokerErrors.unavailable('connection closed after send');

      expect((await triggerCrossed(userId, order)).status).toBe('pending_fire');
      expect(place).toHaveBeenCalledTimes(1);

      const accepted = {
        orderId: 'accepted-standalone-before-crash',
        status: 'submitted' as const,
        contractSymbol: order.contractSymbol,
        side: order.side,
        quantity: order.quantity,
        orderType: order.orderType,
        timestamp: new Date().toISOString(),
      };
      const stale = new Date(Date.now() - 3 * 60_000);
      const audit = prisma.orderAudits.find(
        (candidate) => candidate.idempotencyKey === idempotencyKeyFor(order.id),
      )!;
      audit.createdAt = stale;
      Object.assign(
        prisma.chartOrders.find((candidate) => candidate.id === order.id),
        { triggeredAt: stale },
      );
      (gateway as BrokerGateway).getRecentOrders = jest.fn(async () => [accepted]);

      expect(await service.recoverPendingBrackets(new Date())).toBe(1);
      expect(place).toHaveBeenCalledTimes(1);
      expect(await service.byId(order.id)).toMatchObject({
        status: 'triggered',
        brokerOrderId: accepted.orderId,
      });
    });

    it('recovers an expired fire lease from the accepted order audit without resubmitting', async () => {
      const groupId = 'aaaaaaaa-2222-3333-4444-555555555555';
      const target = await service.create(
        userId,
        draft({ kind: 'target', triggerPrice: 105, orderType: 'market', ocoGroupId: groupId }),
      );
      const stop = await service.create(
        userId,
        draft({ kind: 'stop', triggerPrice: 95, orderType: 'market', ocoGroupId: groupId }),
      );
      const now = new Date();
      const placed = {
        orderId: 'accepted-before-crash',
        status: 'submitted',
        contractSymbol: stop.contractSymbol,
        side: stop.side,
        quantity: stop.quantity,
        orderType: stop.orderType,
        timestamp: now.toISOString(),
      };
      Object.assign(
        prisma.bracketGroups.find((group) => group.id === groupId),
        {
          status: 'pending_fire',
          fireLegId: stop.id,
          leaseOwnerId: 'dead-instance',
          leaseExpiresAt: new Date(now.getTime() - 1),
        },
      );
      Object.assign(
        prisma.chartOrders.find((row) => row.id === stop.id),
        {
          status: 'pending_fire',
          triggeredAt: new Date(now.getTime() - 31_000),
        },
      );
      Object.assign(
        prisma.chartOrders.find((row) => row.id === target.id),
        {
          status: 'cancelled',
        },
      );
      await prisma.orderAudit.create({
        data: {
          userId,
          idempotencyKey: idempotencyKeyFor(stop.id),
          request: {},
          response: placed,
          status: 'submitted',
        },
      });
      const brokerPlace = jest.spyOn(gateway, 'placeOrder');

      expect(await service.recoverPendingBrackets(now)).toBe(1);

      expect(brokerPlace).not.toHaveBeenCalled();
      expect((await service.byId(stop.id))?.status).toBe('triggered');
      expect((await service.byId(stop.id))?.brokerOrderId).toBe(placed.orderId);
      expect((await service.byId(target.id))?.status).toBe('cancelled');
      expect(prisma.bracketGroups.find((group) => group.id === groupId)?.status).toBe('fired');
    });

    it('repairs a legacy half-claim before recovery can send an order', async () => {
      const groupId = 'aaaaaaaa-2222-3333-4444-666666666666';
      const target = await service.create(
        userId,
        draft({
          kind: 'target',
          triggerPrice: 105,
          orderType: 'market',
          side: 'sell',
          ocoGroupId: groupId,
        }),
      );
      const stop = await service.create(
        userId,
        draft({
          kind: 'stop',
          triggerPrice: 95,
          orderType: 'market',
          side: 'sell',
          ocoGroupId: groupId,
        }),
      );
      const now = new Date();
      Object.assign(
        prisma.bracketGroups.find((group) => group.id === groupId),
        {
          status: 'pending_fire',
          fireLegId: stop.id,
          leaseOwnerId: 'dead-pre-transaction-instance',
          leaseExpiresAt: new Date(now.getTime() - 1),
        },
      );
      gateway.setPosition(userId, stop.contractSymbol, 1);
      const brokerPlace = jest.spyOn(gateway, 'placeOrder');

      expect(await service.recoverPendingBrackets(now)).toBe(1);

      expect(brokerPlace).toHaveBeenCalledTimes(1);
      expect((await service.byId(stop.id))?.status).toBe('triggered');
      expect((await service.byId(target.id))?.status).toBe('cancelled');
      expect(
        prisma.chartOrders.filter(
          (order) => order.ocoGroupId === groupId && order.status === 'working',
        ),
      ).toHaveLength(0);
    });

    it('uses the group protected quantity when recovering a fire after a partial scale-down', async () => {
      const groupId = 'bbbbbbbb-2222-3333-4444-555555555555';
      const target = await service.create(
        userId,
        draft({
          kind: 'target',
          triggerPrice: 105,
          orderType: 'market',
          quantity: 2,
          side: 'sell',
          ocoGroupId: groupId,
        }),
      );
      const stop = await service.create(
        userId,
        draft({
          kind: 'stop',
          triggerPrice: 95,
          orderType: 'market',
          quantity: 2,
          side: 'sell',
          ocoGroupId: groupId,
        }),
      );
      const now = new Date();
      Object.assign(
        prisma.bracketGroups.find((group) => group.id === groupId),
        {
          protectedQuantity: 1,
          status: 'pending_fire',
          fireLegId: stop.id,
          leaseOwnerId: 'dead-instance',
          leaseExpiresAt: new Date(now.getTime() - 1),
        },
      );
      Object.assign(
        prisma.chartOrders.find((row) => row.id === stop.id),
        {
          status: 'pending_fire',
          triggeredAt: new Date(now.getTime() - 31_000),
        },
      );
      Object.assign(
        prisma.chartOrders.find((row) => row.id === target.id),
        {
          status: 'cancelled',
        },
      );
      gateway.setPosition(userId, stop.contractSymbol, 1);
      const brokerPlace = jest.spyOn(gateway, 'placeOrder');

      expect(await service.recoverPendingBrackets(now)).toBe(1);

      expect(brokerPlace).toHaveBeenCalledTimes(1);
      expect(brokerPlace.mock.calls[0][1].quantity).toBe(1);
    });
  });

  describe('reconciliation', () => {
    it('expires working lines past their settlement', async () => {
      const order = await service.create(userId, draft());
      const afterSettlement = new Date(Date.parse(order.expiresAt) + 1000);
      const updates: ChartOrder[] = [];
      const subscription = chartEvents.events$.subscribe((event) => updates.push(event.order));

      expect(await service.expireSettled(afterSettlement)).toBe(1);
      await new Promise((resolve) => setImmediate(resolve));
      expect((await service.list(userId))[0].status).toBe('expired');
      expect(updates).toContainEqual(expect.objectContaining({ id: order.id, status: 'expired' }));
      subscription.unsubscribe();
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

    it('does not apply positions from one selected account after the account switches', async () => {
      let accountId = 'account-a';
      (gateway as BrokerGateway).executionScope = jest.fn(async () => ({
        provider: 'webull' as const,
        environment: 'live' as const,
        accountId,
      }));
      const stop = await service.create(
        userId,
        draft({ kind: 'stop', side: 'sell', triggerPrice: 95 }),
      );
      const positionsScope = await service.reconciliationScope(userId, 'live');
      accountId = 'account-b';

      const cancelled = await service.cancelOrphanedBrackets(
        userId,
        'live',
        [],
        new Date(Date.now() + 120_000),
        positionsScope,
      );

      expect(cancelled).toEqual([]);
      expect((await service.byId(stop.id))?.status).toBe('working');
    });

    it('scales both working siblings down when the protected position shrinks', async () => {
      const groupId = '20202020-2222-3333-4444-555555555555';
      const target = await service.create(
        userId,
        draft({ kind: 'target', quantity: 3, triggerPrice: 105, ocoGroupId: groupId }),
      );
      const stop = await service.create(
        userId,
        draft({ kind: 'stop', quantity: 3, triggerPrice: 95, ocoGroupId: groupId }),
      );

      await service.cancelOrphanedBrackets(
        userId,
        'live',
        [{ symbol: stop.contractSymbol, quantity: 1 }],
        new Date(Date.now() + 120_000),
      );

      expect((await service.byId(target.id))?.quantity).toBe(1);
      expect((await service.byId(stop.id))?.quantity).toBe(1);
      expect(prisma.bracketGroups.find((group) => group.id === groupId)?.protectedQuantity).toBe(1);
    });

    /**
     * The sweep reads `working` rows, then writes — and a leg can be claimed for
     * firing across that await. The two are correlated rather than independent:
     * a stop firing is exactly what closes the position that makes it look
     * orphaned. Writing blindly by id would stamp `cancelled` over a line whose
     * order is already at the broker, so the chart would show a cancelled stop
     * while a live one sat in the book.
     */
    it('does not cancel a leg that was claimed for firing after the sweep read it', async () => {
      const stop = await service.create(userId, draft({ kind: 'stop' }));
      const later = new Date(Date.now() + 120_000);

      // Claim it the way `fire` would, between the sweep's read and its write.
      const findMany = prisma.chartOrder.findMany.bind(prisma.chartOrder);
      jest.spyOn(prisma.chartOrder, 'findMany').mockImplementationOnce(async (args?: unknown) => {
        const rows = await findMany(args);
        await service.claimForFire(stop.id, new Date());
        return rows;
      });

      const cancelled = await service.cancelOrphanedBrackets(userId, 'live', [], later);

      expect(cancelled).toEqual([]);
      expect((await service.list(userId))[0].status).toBe('pending_fire');
    });
  });

  describe('triggerNow re-validates the crossing server-side', () => {
    it('refuses a line the underlying has not actually crossed', async () => {
      const order = await service.create(userId, draft()); // arms at 100, trigger 98

      // The client claims a crossing; the server's own quote says otherwise.
      await expect(service.triggerNow(userId, order.id)).rejects.toMatchObject({
        status: 409,
        code: 'CHART_ORDER_NOT_CROSSED',
      });
      expect((await service.list(userId))[0].status).toBe('working');
    });

    it('refuses to act on a stale quote', async () => {
      const order = await service.create(userId, draft());
      gateway.price = 97; // genuinely crossed…
      gateway.quoteTimestamp = new Date(Date.now() - 60_000).toISOString(); // …but from a dead feed

      await expect(service.triggerNow(userId, order.id)).rejects.toMatchObject({
        status: 503,
        code: 'QUOTE_STALE',
      });
      expect((await service.list(userId))[0].status).toBe('working');
    });

    it('fires when the server sees the crossing for itself', async () => {
      const order = await service.create(userId, draft());

      const fired = await triggerCrossed(userId, order);

      expect(fired.status).toBe('triggered');
      expect(fired.brokerOrderId).toBeTruthy();
    });
  });
});
