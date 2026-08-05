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
import { ChartOrderWatcherService, mapWithConcurrency } from './chart-order-watcher.service';
import { ChartOrdersService, idempotencyKeyFor } from './chart-orders.service';
import { CreateChartOrderDto } from './dto/chart-order.dto';

/** 11:00 New York on a Friday — inside the regular cash session. */
const IN_SESSION = new Date('2026-07-24T15:00:00Z');
/** 20:00 New York, same day — the session is closed. */
const AFTER_CLOSE = new Date('2026-07-25T00:00:00Z');

const NEAREST = () =>
  optionExpirations('SPY', new Date()).find(
    (expiration) => optionSettlementAt(expiration, 'SPY').getTime() > Date.now(),
  )!;

function draft(overrides: Partial<CreateChartOrderDto> = {}): CreateChartOrderDto {
  return {
    underlying: 'SPY',
    triggerPrice: 98,
    side: 'buy' as OrderSide,
    quantity: 1,
    orderType: 'market' as OrderType,
    kind: 'limit' as ChartOrderKind,
    optionType: 'call',
    expiration: NEAREST(),
    strike: 101,
    ...overrides,
  } as CreateChartOrderDto;
}

describe('ChartOrderWatcherService', () => {
  let prisma: InMemoryPrismaService;
  let gateway: StubBrokerGateway;
  let chartOrders: ChartOrdersService;
  let trading: TradingService;
  let orders: OrdersService;
  let events: ChartOrderEventsService;
  let emitted: ChartOrder[];
  let watcher: ChartOrderWatcherService;
  let userId: string;

  // Shared by the watcher and the service: both read `staleQuoteMs`, and they
  // must agree on it or the two staleness gates would disagree in tests.
  const config = {
    get: (key: string) =>
      ({
        'chartOrders.watcherEnabled': false, // never start the real interval in tests
        'chartOrders.tickMs': 1_000,
        'chartOrders.staleQuoteMs': 10_000,
      })[key],
  } as unknown as ConfigService;

  function buildWatcher(): ChartOrderWatcherService {
    return new ChartOrderWatcherService(
      prisma as unknown as ConstructorParameters<typeof ChartOrderWatcherService>[0],
      chartOrders,
      events,
      gateway as BrokerGateway,
      config,
    );
  }

  beforeEach(async () => {
    prisma = new InMemoryPrismaService();
    gateway = new StubBrokerGateway();
    orders = new OrdersService(
      prisma as unknown as ConstructorParameters<typeof OrdersService>[0],
      new OrderEventsService(),
      gateway as BrokerGateway,
    );
    trading = new TradingService(
      prisma as unknown as ConstructorParameters<typeof TradingService>[0],
      gateway as BrokerGateway,
      orders,
    );
    events = new ChartOrderEventsService();
    chartOrders = new ChartOrdersService(
      prisma as unknown as ConstructorParameters<typeof ChartOrdersService>[0],
      gateway as BrokerGateway,
      trading,
      events,
      config,
    );
    emitted = [];
    events.events$.subscribe((event) => emitted.push(event.order));
    watcher = buildWatcher();

    const user = await prisma.user.create({
      data: { email: 'watcher@example.com', passwordHash: 'x' },
    });
    userId = user.id as string;
    prisma.acceptCurrentTradingLegal(userId);
  });

  afterEach(() => {
    watcher.onModuleDestroy();
    orders.onModuleDestroy();
  });

  const statusOf = async (id: string) => (await chartOrders.byId(id))?.status;

  /** Opens the strike-101 call the drafts bracket, so the stub reports a position. */
  const openPosition = () =>
    trading.place(
      userId,
      {
        underlying: 'SPY',
        assetClass: 'option',
        side: 'buy',
        quantity: 1,
        orderType: 'market',
        selection: {
          mode: 'explicit',
          optionType: 'call',
          expiration: NEAREST(),
          strike: 101,
        },
      },
      'open-position',
    );

  describe('crossing', () => {
    it('fires when the underlying crosses the trigger from the armed side', async () => {
      const place = jest.spyOn(gateway, 'placeOrder');
      // Armed at 100 with the trigger at 98: it fires on the way down.
      const order = await chartOrders.create(userId, draft({ triggerPrice: 98 }));

      // Whole dollars only: the stub derives its strike ladder from the price,
      // so a fractional price would move strike 101 off the chain.
      gateway.price = 97;
      await watcher.tick(IN_SESSION);

      expect(place).toHaveBeenCalledTimes(1);
      expect(await statusOf(order.id)).toBe('triggered');
      expect(watcher.metrics.fired).toBe(1);
    });

    it('does not fire while price merely approaches the trigger', async () => {
      const place = jest.spyOn(gateway, 'placeOrder');
      await chartOrders.create(userId, draft({ triggerPrice: 98 }));

      gateway.price = 98.5;
      await watcher.tick(IN_SESSION);

      expect(place).not.toHaveBeenCalled();
    });

    it('does not fire a line armed on the other side of where price already is', async () => {
      const place = jest.spyOn(gateway, 'placeOrder');
      // Armed at 100 above a trigger of 98, then price runs UP. A bare crossing
      // test with no armed side would fire this the moment it came back down
      // through 98 from 99 — but so would the correct one. The bug this guards
      // is firing immediately at creation, so tick with price unchanged.
      await chartOrders.create(userId, draft({ triggerPrice: 98 }));

      await watcher.tick(IN_SESSION);

      expect(place).not.toHaveBeenCalled();
    });

    it('fires a buy limit that price gapped straight through with no tick in between', async () => {
      const place = jest.spyOn(gateway, 'placeOrder');
      const order = await chartOrders.create(userId, draft({ triggerPrice: 98 }));

      // The watcher never observed 99, 98.5, … — it restarts (or first polls)
      // with price already below. Testing armPrice → last catches it anyway.
      gateway.price = 90;
      await watcher.tick(IN_SESSION);

      expect(place).toHaveBeenCalledTimes(1);
      expect(await statusOf(order.id)).toBe('triggered');
    });

    it('fires an upward trigger only on the way up', async () => {
      const place = jest.spyOn(gateway, 'placeOrder');
      // Armed at 100, trigger at 105: armed from below.
      await chartOrders.create(userId, draft({ triggerPrice: 105 }));

      gateway.price = 95;
      await watcher.tick(IN_SESSION);
      expect(place).not.toHaveBeenCalled();

      gateway.price = 106;
      await watcher.tick(IN_SESSION);
      expect(place).toHaveBeenCalledTimes(1);
    });

    it('never fires off a stale quote', async () => {
      const place = jest.spyOn(gateway, 'placeOrder');
      const order = await chartOrders.create(userId, draft({ triggerPrice: 98 }));

      gateway.price = 90;
      // A halted or dead feed replaying an old print must not trip every level.
      gateway.quoteTimestamp = new Date(IN_SESSION.getTime() - 60_000).toISOString();
      await watcher.tick(IN_SESSION);

      expect(place).not.toHaveBeenCalled();
      expect(await statusOf(order.id)).toBe('working');
    });

    it('never fires a practice line after the user switches to live', async () => {
      const place = jest.spyOn(gateway, 'placeOrder');
      const practice = await prisma.user.create({
        data: { email: 'practice@example.com', passwordHash: 'x', tradingMode: 'practice' },
      });
      const practiceId = practice.id as string;
      prisma.acceptCurrentTradingLegal(practiceId);
      await chartOrders.create(practiceId, draft({ triggerPrice: 98 }));
      expect(prisma.chartOrders[0].environment).toBe('practice');

      // They flip to live. The line was armed against paper money; firing it
      // now would send a real order the user never intended.
      prisma.users.find((u) => u.id === practiceId).tradingMode = 'live';
      gateway.price = 90;
      await watcher.tick(IN_SESSION);

      expect(place).not.toHaveBeenCalled();
      expect(await statusOf(prisma.chartOrders[0].id)).toBe('working');
    });

    it('fires it again once they switch back', async () => {
      const place = jest.spyOn(gateway, 'placeOrder');
      const practice = await prisma.user.create({
        data: { email: 'back@example.com', passwordHash: 'x', tradingMode: 'practice' },
      });
      const practiceId = practice.id as string;
      prisma.acceptCurrentTradingLegal(practiceId);
      await chartOrders.create(practiceId, draft({ triggerPrice: 98 }));

      prisma.users.find((u) => u.id === practiceId).tradingMode = 'live';
      gateway.price = 90;
      await watcher.tick(IN_SESSION);
      expect(place).not.toHaveBeenCalled();

      prisma.users.find((u) => u.id === practiceId).tradingMode = 'practice';
      await watcher.tick(IN_SESSION);
      expect(place).toHaveBeenCalledTimes(1);
    });

    it('does not fire outside the regular session', async () => {
      const place = jest.spyOn(gateway, 'placeOrder');
      await chartOrders.create(userId, draft({ triggerPrice: 98 }));

      gateway.price = 90;
      await watcher.tick(AFTER_CLOSE);

      expect(place).not.toHaveBeenCalled();
    });

    it('fires each line at most once even across repeated ticks', async () => {
      const place = jest.spyOn(gateway, 'placeOrder');
      await chartOrders.create(userId, draft({ triggerPrice: 98 }));

      gateway.price = 90;
      await watcher.tick(IN_SESSION);
      await watcher.tick(IN_SESSION);
      await watcher.tick(IN_SESSION);

      expect(place).toHaveBeenCalledTimes(1);
    });
  });

  describe('firing', () => {
    it('uses a deterministic idempotency key derived from the line id', async () => {
      const place = jest.spyOn(trading, 'place');
      const order = await chartOrders.create(userId, draft({ triggerPrice: 98 }));

      gateway.price = 90;
      await watcher.tick(IN_SESSION);

      expect(place.mock.calls[0][2]).toBe(idempotencyKeyFor(order.id));
    });

    it('places exactly one broker order when the client already fired the same line', async () => {
      const order = await chartOrders.create(userId, draft({ triggerPrice: 98 }));
      const place = jest.spyOn(gateway, 'placeOrder');

      // The client sees the cross first and submits with the shared key.
      const clientResult = await trading.place(
        userId,
        {
          underlying: 'SPY',
          assetClass: 'option',
          side: 'buy',
          quantity: 1,
          orderType: 'market',
          selection: {
            mode: 'explicit',
            optionType: 'call',
            expiration: order.expiration,
            strike: order.strike,
          },
        },
        idempotencyKeyFor(order.id),
      );

      // The watcher sees the same cross a moment later.
      gateway.price = 90;
      await watcher.tick(IN_SESSION);

      expect(place).toHaveBeenCalledTimes(1);
      const row = await chartOrders.byId(order.id);
      expect(row?.brokerOrderId).toBe(clientResult.orderId);
    });

    it('marks a rejected fire failed with the reason, instead of losing the line', async () => {
      const order = await chartOrders.create(userId, draft({ triggerPrice: 98 }));
      gateway.placeError = new Error('insufficient buying power');

      gateway.price = 90;
      await watcher.tick(IN_SESSION);

      const row = await chartOrders.byId(order.id);
      expect(row?.status).toBe('failed');
      expect(row?.lastError).toContain('insufficient buying power');
      expect(watcher.metrics.failed).toBe(1);
      expect(emitted[emitted.length - 1]?.status).toBe('failed');
    });

    it('retires the OCO sibling when one leg fires', async () => {
      // A bracket only exists behind a position — open one so the orphan sweep
      // does not (correctly) retire both legs.
      await openPosition();
      const groupId = '11111111-2222-3333-4444-555555555555';
      const target = await chartOrders.create(
        userId,
        draft({ kind: 'target', side: 'sell', triggerPrice: 105, ocoGroupId: groupId }),
      );
      const stop = await chartOrders.create(
        userId,
        draft({ kind: 'stop', side: 'sell', triggerPrice: 95, ocoGroupId: groupId }),
      );

      gateway.price = 94;
      await watcher.tick(IN_SESSION);

      expect(await statusOf(stop.id)).toBe('triggered');
      expect(await statusOf(target.id)).toBe('cancelled');
      expect(emitted.map((o) => o.id)).toContain(target.id);
    });

    it('respects the kill switch — firing goes through the normal order path', async () => {
      const place = jest.spyOn(gateway, 'placeOrder');
      const order = await chartOrders.create(userId, draft({ triggerPrice: 98 }));
      prisma.setTradingDisabled(userId, true);

      gateway.price = 90;
      await watcher.tick(IN_SESSION);

      expect(place).not.toHaveBeenCalled();
      expect(await statusOf(order.id)).toBe('failed');
    });
  });

  describe('reconciliation', () => {
    it('expires lines whose contract has settled', async () => {
      const order = await chartOrders.create(userId, draft());
      const past = new Date(Date.parse(order.expiresAt) + 60_000);

      await watcher.tick(past);

      expect(await statusOf(order.id)).toBe('expired');
      expect(watcher.metrics.expired).toBe(1);
    });

    it('cancels a bracket leg whose position is gone', async () => {
      const stop = await chartOrders.create(userId, draft({ kind: 'stop', side: 'sell' }));
      jest.spyOn(gateway, 'getPositions').mockResolvedValue([]);

      await watcher.tick(new Date(Date.now() + 120_000));

      expect(await statusOf(stop.id)).toBe('cancelled');
      expect(watcher.metrics.orphansCancelled).toBe(1);
    });

    it('spares a bracket younger than the grace period, so opening a position does not race the sweep', async () => {
      const stop = await chartOrders.create(userId, draft({ kind: 'stop', side: 'sell' }));
      // The broker has not reported the fill yet — the leg must survive.
      jest.spyOn(gateway, 'getPositions').mockResolvedValue([]);

      await watcher.tick(IN_SESSION);

      expect(await statusOf(stop.id)).toBe('working');
    });

    it('does not orphan a practice bracket using live positions', async () => {
      const practice = await prisma.user.create({
        data: { email: 'orphan@example.com', passwordHash: 'x', tradingMode: 'practice' },
      });
      const practiceId = practice.id as string;
      prisma.acceptCurrentTradingLegal(practiceId);
      const stop = await chartOrders.create(practiceId, draft({ kind: 'stop', side: 'sell' }));
      prisma.users.find((u) => u.id === practiceId).tradingMode = 'live';
      // The live account has no such position — but that says nothing about the
      // practice one the bracket belongs to.
      jest.spyOn(gateway, 'getPositions').mockResolvedValue([]);

      await watcher.tick(new Date(Date.now() + 120_000));

      expect(await statusOf(stop.id)).toBe('working');
    });

    it('leaves brackets alone when the positions read fails', async () => {
      const stop = await chartOrders.create(userId, draft({ kind: 'stop', side: 'sell' }));
      jest.spyOn(gateway, 'getPositions').mockRejectedValue(new Error('broker down'));

      await watcher.tick(new Date(Date.now() + 120_000));

      expect(await statusOf(stop.id)).toBe('working');
    });
  });

  describe('lease', () => {
    it('lets only one watcher instance process a tick', async () => {
      const place = jest.spyOn(gateway, 'placeOrder');
      await chartOrders.create(userId, draft({ triggerPrice: 98 }));
      const second = buildWatcher();

      gateway.price = 90;
      await Promise.all([watcher.tick(IN_SESSION), second.tick(IN_SESSION)]);

      expect(place).toHaveBeenCalledTimes(1);
      expect(watcher.metrics.ticks + second.metrics.ticks).toBe(1);
      second.onModuleDestroy();
    });

    /**
     * Failover. The holder dies without releasing the lease, so the standby has
     * to wait it out — and then process, or every line stops being watched until
     * someone notices. The standby has no price history, which is exactly why a
     * line resumes from its own `armPrice`: this crossing was never observed by
     * the instance that ends up firing it.
     */
    it('hands the lease to a standby once the holder stops renewing, and it resumes from armPrice', async () => {
      const place = jest.spyOn(gateway, 'placeOrder');
      const order = await chartOrders.create(userId, draft({ triggerPrice: 98 }));
      const standby = buildWatcher();

      // The holder takes the lease on a tick that does not cross the level.
      gateway.price = 99;
      await watcher.tick(IN_SESSION);
      expect(await statusOf(order.id)).toBe('working');

      // Standby is locked out while the lease is live.
      gateway.price = 90;
      await standby.tick(new Date(IN_SESSION.getTime() + 5_000));
      expect(place).not.toHaveBeenCalled();
      expect(standby.metrics.ticks).toBe(0);

      // Holder is gone. Past the 30s lease the standby takes over and fires the
      // level it never watched cross.
      watcher.onModuleDestroy();
      await standby.tick(new Date(IN_SESSION.getTime() + 31_000));

      expect(standby.metrics.ticks).toBe(1);
      expect(place).toHaveBeenCalledTimes(1);
      expect(await statusOf(order.id)).toBe('triggered');
      standby.onModuleDestroy();
    });
  });
});

describe('mapWithConcurrency', () => {
  it('never runs more than `limit` calls at once', async () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;
    const started: number[] = [];

    await mapWithConcurrency(items, 4, async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      started.push(item);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    });

    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(started.sort((a, b) => a - b)).toEqual(items);
  });

  it('runs every item even when limit exceeds the item count', async () => {
    const seen: number[] = [];
    await mapWithConcurrency([1, 2, 3], 10, async (item) => {
      seen.push(item);
    });
    expect(seen.sort()).toEqual([1, 2, 3]);
  });

  it('propagates a rejection from any worker', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('does nothing for an empty item list', async () => {
    const calls: number[] = [];
    await mapWithConcurrency([], 5, async (item: number) => {
      calls.push(item);
    });
    expect(calls).toHaveLength(0);
  });
});
