import { ConfigService } from '@nestjs/config';
import { ChartOrder, ChartOrderKind, OrderSide, OrderType } from '@0dtetrader/shared-types';
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
      gateway as BrokerGateway,
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
      {
        get: (key: string) => (key === 'chartOrders.staleQuoteMs' ? 10_000 : undefined),
      } as unknown as ConfigService,
    );
    const user = await prisma.user.create({
      data: { email: 'chart@example.com', passwordHash: 'x' },
    });
    userId = user.id as string;
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
      gateway.placeError = new Error('insufficient buying power');

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
        throw new Error('broker refused');
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
      gateway.placeError = new Error('insufficient buying power');

      const fired = await triggerCrossed(userId, stop);

      expect(fired.status).toBe('failed');
      expect((await service.byId(target.id))?.status).toBe('working');
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

    it('still allows a second leg while the bracket is fully armed', async () => {
      const groupId = '88888888-2222-3333-4444-555555555555';
      await service.create(userId, draft({ kind: 'stop', triggerPrice: 95, ocoGroupId: groupId }));

      await expect(
        service.create(userId, draft({ kind: 'target', triggerPrice: 105, ocoGroupId: groupId })),
      ).resolves.toBeDefined();
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
      gateway.placeError = new Error('broker refused');
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
      expect((await service.list(userId))[0].status).toBe('triggered');
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
