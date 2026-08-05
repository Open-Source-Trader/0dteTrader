import { OrderResult } from '@0dtetrader/shared-types';
import { OrderEventsService } from '../broker/order-events.service';
import { InMemoryPrismaService } from '../../test/in-memory-prisma.service';
import { OrdersService } from './orders.service';

const USER = 'user-1';
const OCC = 'SPY260717C00505000';

let orderSeq = 0;

function fill(overrides: Partial<OrderResult> = {}): OrderResult {
  orderSeq += 1;
  const placed = 1_752_000_000_000 + orderSeq * 60_000;
  return {
    orderId: `O-${orderSeq}`,
    status: 'filled',
    contractSymbol: OCC,
    side: 'buy',
    quantity: 1,
    orderType: 'market',
    filledPrice: 1.0,
    timestamp: new Date(placed).toISOString(),
    // Broker-reported execution: deliberately later than placement, so an
    // assertion anchored on the wrong timestamp fails loudly.
    filledAt: new Date(placed + 30_000).toISOString(),
    ...overrides,
  };
}

describe('OrdersService', () => {
  let prisma: InMemoryPrismaService;
  let events: OrderEventsService;
  let orders: OrdersService;

  beforeEach(() => {
    orderSeq = 0;
    prisma = new InMemoryPrismaService();
    events = new OrderEventsService();
    orders = new OrdersService(
      prisma as unknown as ConstructorParameters<typeof OrdersService>[0],
      events,
    );
  });

  afterEach(() => {
    orders.onModuleDestroy();
  });

  /** The cumulative fill curve recorded for one order, in curve order. */
  const cumulativesFor = (orderId: string): number[] =>
    prisma.tradeOrderExecutions
      .filter((e) => e.orderId === orderId)
      .map((e) => e.cumulative)
      .sort((a: number, b: number) => a - b);

  it('persists orders arriving on the events bus, updating status on later events', async () => {
    const submitted = fill({
      status: 'submitted',
      filledPrice: undefined,
      orderType: 'mid',
      limitPrice: 1.05,
    });
    events.emit(USER, submitted);
    // The async fill for the same orderId arrives later.
    events.emit(USER, { ...submitted, status: 'filled', filledPrice: 1.05 });
    await new Promise((resolve) => setImmediate(resolve));

    const history = await orders.history(USER);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0].status).toBe('filled');
    expect(history.entries[0].filledPrice).toBe(1.05);
  });

  it('computes realized P/L for an option round trip (buy 2 @1.00, sell 2 @1.50)', async () => {
    await orders.record(USER, fill({ side: 'buy', quantity: 2, filledPrice: 1.0 }));
    await orders.record(USER, fill({ side: 'sell', quantity: 2, filledPrice: 1.5 }));

    const history = await orders.history(USER);
    // Newest first: the closing sell leads.
    expect(history.entries[0].side).toBe('sell');
    expect(history.entries[0].realizedPnl).toBe(100); // (1.50-1.00) × 2 × 100
    expect(history.entries[1].realizedPnl).toBeNull(); // opening fill
    expect(history.totalRealizedPnl).toBe(100);
  });

  it('handles partial closes with average cost', async () => {
    await orders.record(USER, fill({ side: 'buy', quantity: 2, filledPrice: 1.0 }));
    await orders.record(USER, fill({ side: 'buy', quantity: 2, filledPrice: 2.0 }));
    // Average cost is 1.50; close half at 2.00.
    await orders.record(USER, fill({ side: 'sell', quantity: 2, filledPrice: 2.0 }));

    const history = await orders.history(USER);
    expect(history.entries[0].realizedPnl).toBe(100); // (2.00-1.50) × 2 × 100
  });

  it('accounts partial fills at the broker-reported filled quantity, not the order quantity', async () => {
    // 10-lot buy only fills 2 before resting; history must book 2, not 10.
    await orders.record(
      USER,
      fill({
        side: 'buy',
        quantity: 10,
        filledPrice: 1.0,
        status: 'partially_filled',
        filledQuantity: 2,
      }),
    );
    // The matching 10-lot sell fills 2 and is then cancelled — the executed
    // portion is still a real closing fill.
    await orders.record(
      USER,
      fill({
        side: 'sell',
        quantity: 10,
        filledPrice: 1.5,
        status: 'cancelled',
        filledQuantity: 2,
      }),
    );

    const history = await orders.history(USER);
    expect(history.entries[0].realizedPnl).toBe(100); // (1.50-1.00) × 2 × 100
    expect(history.totalRealizedPnl).toBe(100);
  });

  it('realizes a loss when covering a short above the sale price', async () => {
    await orders.record(USER, fill({ side: 'sell', quantity: 1, filledPrice: 1.0 }));
    await orders.record(USER, fill({ side: 'buy', quantity: 1, filledPrice: 1.4 }));

    const history = await orders.history(USER);
    expect(history.entries[0].realizedPnl).toBe(-40); // short from 1.00, covered 1.40
    expect(history.totalRealizedPnl).toBe(-40);
  });

  it('ignores a degenerate filled row reporting zero executed quantity', async () => {
    // A broker snapshot can report status `filled` with an explicit
    // filledQuantity of 0 (transient poll state). Booking it would divide 0/0
    // and NaN-poison the contract's average cost forever.
    await orders.record(
      USER,
      fill({ side: 'buy', quantity: 5, filledPrice: 1.2, filledQuantity: 0 }),
    );
    // A real round trip afterwards must still compute cleanly.
    await orders.record(USER, fill({ side: 'buy', quantity: 2, filledPrice: 1.0 }));
    await orders.record(USER, fill({ side: 'sell', quantity: 2, filledPrice: 1.5 }));

    const history = await orders.history(USER);
    expect(history.entries[2].realizedPnl).toBeNull(); // the degenerate row
    expect(history.entries[0].realizedPnl).toBe(100);
    expect(Number.isNaN(history.totalRealizedPnl)).toBe(false);
    expect(history.totalRealizedPnl).toBe(100);
  });

  it('keeps rejected and cancelled orders in history with no P/L', async () => {
    await orders.record(USER, fill({ status: 'rejected', filledPrice: undefined }));
    await orders.record(
      USER,
      fill({ status: 'cancelled', filledPrice: undefined, orderType: 'mid' }),
    );

    const history = await orders.history(USER);
    expect(history.entries.map((e) => e.status)).toEqual(['cancelled', 'rejected']);
    expect(history.entries.every((e) => e.realizedPnl === null)).toBe(true);
    expect(history.totalRealizedPnl).toBe(0);
  });

  it('scopes history to the requesting user', async () => {
    await orders.record(USER, fill());
    await orders.record('user-2', fill({ contractSymbol: 'QQQ260717C00505000' }));

    const history = await orders.history(USER);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0].contractSymbol).toBe(OCC);
  });

  /**
   * History spans both environments. A practice buy must never become the cost
   * basis for a live sale of the same contract — that would report realized P/L
   * the account never earned (and hide the real, still-open live short).
   */
  it('never averages a practice fill into a live position of the same contract', async () => {
    const practiceUser = await prisma.user.create({
      data: { email: 'env-book@example.com', passwordHash: 'x', tradingMode: 'practice' },
    });
    const practiceId = practiceUser.id as string;
    // Same user, same contract, one fill in each environment.
    await orders.record(practiceId, fill({ side: 'buy', quantity: 1, filledPrice: 1.0 }));
    prisma.users.find((u) => u.id === practiceId).tradingMode = 'live';
    await orders.record(practiceId, fill({ side: 'sell', quantity: 1, filledPrice: 3.0 }));

    const history = await orders.history(practiceId);

    // The live sell opens a short; it closes nothing, so it realizes nothing.
    expect(history.entries.every((e) => e.realizedPnl === null)).toBe(true);
    expect(history.totalRealizedPnl).toBe(0);
  });

  describe('recordUnderlyingPrice', () => {
    /**
     * The broker's status poll starts before the placement path gets control,
     * so a fill can land in between. Stamping the anchor must not drag the row
     * back to the submitted snapshot the placement path is holding.
     */
    it('never rolls a fill back to the submitted status it raced', async () => {
      const submitted = fill({ status: 'submitted', filledPrice: undefined, orderType: 'mid' });
      await orders.record(USER, submitted);
      // The poll reports the fill.
      await orders.record(USER, { ...submitted, status: 'filled', filledPrice: 1.42 });

      // Placement path stamps the anchor, still holding the submitted result.
      await orders.recordUnderlyingPrice(USER, submitted, 600);

      const row = prisma.tradeOrders.find((o) => o.id === submitted.orderId);
      expect(row.status).toBe('filled');
      expect(row.filledPrice).toBe(1.42);
      expect(row.underlyingPrice).toBe(600);
    });

    it('creates the row when it wins the race against the events bus', async () => {
      const order = fill({ filledPrice: 1.0 });

      await orders.recordUnderlyingPrice(USER, order, 600);

      const row = prisma.tradeOrders.find((o) => o.id === order.orderId);
      expect(row.underlyingPrice).toBe(600);
      expect(row.status).toBe('filled');
    });

    it('leaves the anchor alone when a later status update arrives', async () => {
      const order = fill({ status: 'submitted', filledPrice: undefined });
      await orders.recordUnderlyingPrice(USER, order, 600);

      await orders.record(USER, { ...order, status: 'filled', filledPrice: 1.1 });

      const row = prisma.tradeOrders.find((o) => o.id === order.orderId);
      expect(row.underlyingPrice).toBe(600);
      expect(row.filledPrice).toBe(1.1);
    });
  });

  describe('positionAnchors (chart entry line)', () => {
    it('averages the underlying price over the fills that opened the position', async () => {
      await orders.recordUnderlyingPrice(
        USER,
        fill({ side: 'buy', quantity: 1, filledPrice: 1.0 }),
        600,
      );
      await orders.recordUnderlyingPrice(
        USER,
        fill({ side: 'buy', quantity: 3, filledPrice: 1.2 }),
        604,
      );

      // Quantity-weighted: (600×1 + 604×3) / 4
      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.underlyingEntryPrice).toBe(603);
    });

    it('carries openedAt but no price for fills without an underlying price', async () => {
      // Opened before the column existed, or outside the app: no entry-line
      // level, but the position still has an opening time.
      const opening = fill({ side: 'buy', quantity: 1, filledPrice: 1.0 });
      await orders.record(USER, opening);

      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.underlyingEntryPrice).toBeUndefined();
      expect(anchor?.openedAt).toEqual(new Date(opening.filledAt!));
    });

    it('blends only the fills that reported a price, never averaging a missing one in as zero', async () => {
      await orders.record(USER, fill({ side: 'buy', quantity: 1, filledPrice: 1.0 }));
      await orders.recordUnderlyingPrice(
        USER,
        fill({ side: 'buy', quantity: 1, filledPrice: 1.0 }),
        604,
      );

      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.underlyingEntryPrice).toBe(604);
    });

    it('leaves the anchor untouched when the position is only partially closed', async () => {
      await orders.recordUnderlyingPrice(
        USER,
        fill({ side: 'buy', quantity: 2, filledPrice: 1.0 }),
        600,
      );
      await orders.recordUnderlyingPrice(
        USER,
        fill({ side: 'buy', quantity: 2, filledPrice: 1.0 }),
        610,
      );
      await orders.recordUnderlyingPrice(
        USER,
        fill({ side: 'sell', quantity: 2, filledPrice: 1.5 }),
        615,
      );

      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.underlyingEntryPrice).toBe(605);
    });

    it('re-weights a later add against the remaining open quantity, not the closed one', async () => {
      await orders.recordUnderlyingPrice(
        USER,
        fill({ side: 'buy', quantity: 2, filledPrice: 1.0 }),
        600,
      );
      await orders.recordUnderlyingPrice(
        USER,
        fill({ side: 'buy', quantity: 2, filledPrice: 1.0 }),
        610,
      );
      await orders.recordUnderlyingPrice(
        USER,
        fill({ side: 'sell', quantity: 2, filledPrice: 1.5 }),
        615,
      );
      await orders.recordUnderlyingPrice(
        USER,
        fill({ side: 'buy', quantity: 2, filledPrice: 1.0 }),
        620,
      );

      // 2 open at 605 + 2 new at 620 — the closed 2 must not still carry weight.
      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.underlyingEntryPrice).toBe(612.5);
    });

    it('drops the anchor once the position is flat', async () => {
      await orders.recordUnderlyingPrice(
        USER,
        fill({ side: 'buy', quantity: 1, filledPrice: 1.0 }),
        600,
      );
      await orders.recordUnderlyingPrice(
        USER,
        fill({ side: 'sell', quantity: 1, filledPrice: 1.5 }),
        610,
      );

      expect(await orders.positionAnchors(USER, [OCC]).then((m) => m.size)).toBe(0);
    });

    it('re-anchors on the flipping fill when a position reverses through zero', async () => {
      await orders.recordUnderlyingPrice(
        USER,
        fill({ side: 'buy', quantity: 1, filledPrice: 1.0 }),
        600,
      );
      await orders.recordUnderlyingPrice(
        USER,
        fill({ side: 'sell', quantity: 3, filledPrice: 1.5 }),
        610,
      );

      // Now short 2, opened at the price the reversal happened at.
      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.underlyingEntryPrice).toBe(610);
    });

    it('only replays the contracts asked for, and none when asked for none', async () => {
      const other = 'QQQ260717C00505000';
      await orders.recordUnderlyingPrice(
        USER,
        fill({ side: 'buy', quantity: 1, filledPrice: 1.0 }),
        600,
      );
      await orders.recordUnderlyingPrice(
        USER,
        fill({ contractSymbol: other, side: 'buy', quantity: 1, filledPrice: 1.0 }),
        500,
      );

      const anchors = await orders.positionAnchors(USER, [other]);
      expect(anchors.size).toBe(1);
      expect(anchors.get(other)?.underlyingEntryPrice).toBe(500);
      expect(await orders.positionAnchors(USER, [])).toEqual(new Map());
    });

    it('stamps openedAt from the opening fill and keeps it across adds', async () => {
      const opening = fill({ side: 'buy', quantity: 1, filledPrice: 1.0 });
      await orders.recordUnderlyingPrice(USER, opening, 600);
      await orders.recordUnderlyingPrice(
        USER,
        fill({ side: 'buy', quantity: 3, filledPrice: 1.2 }),
        604,
      );

      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.openedAt).toEqual(new Date(opening.filledAt!));
    });

    it('keeps openedAt across a partial close', async () => {
      const opening = fill({ side: 'buy', quantity: 2, filledPrice: 1.0 });
      await orders.recordUnderlyingPrice(USER, opening, 600);
      await orders.recordUnderlyingPrice(
        USER,
        fill({ side: 'sell', quantity: 1, filledPrice: 1.5 }),
        610,
      );

      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.openedAt).toEqual(new Date(opening.filledAt!));
    });

    it('resets openedAt when a position closes and reopens', async () => {
      await orders.recordUnderlyingPrice(
        USER,
        fill({ side: 'buy', quantity: 1, filledPrice: 1.0 }),
        600,
      );
      await orders.recordUnderlyingPrice(
        USER,
        fill({ side: 'sell', quantity: 1, filledPrice: 1.5 }),
        610,
      );
      const reopening = fill({ side: 'buy', quantity: 1, filledPrice: 1.1 });
      await orders.recordUnderlyingPrice(USER, reopening, 620);

      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.openedAt).toEqual(new Date(reopening.filledAt!));
    });

    it('re-anchors openedAt on the flipping fill when a position reverses', async () => {
      await orders.recordUnderlyingPrice(
        USER,
        fill({ side: 'buy', quantity: 1, filledPrice: 1.0 }),
        600,
      );
      const flipping = fill({ side: 'sell', quantity: 3, filledPrice: 1.5 });
      await orders.recordUnderlyingPrice(USER, flipping, 610);

      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.openedAt).toEqual(new Date(flipping.filledAt!));
    });

    it('anchors openedAt on the execution time, never the placement time', async () => {
      // A resting limit placed at 14:00 that filled three minutes later must
      // report the fill, not the placement, as the position's opening.
      const placed = new Date('2026-08-02T14:00:00.000Z');
      const executed = new Date('2026-08-02T14:03:00.000Z');
      await orders.record(
        USER,
        fill({ timestamp: placed.toISOString(), filledAt: executed.toISOString() }),
      );

      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.openedAt).toEqual(executed);
    });

    it('keeps the first fill time when later fill events arrive (first fill wins)', async () => {
      const t1 = new Date('2026-08-02T14:03:00.000Z');
      const t2 = new Date('2026-08-02T14:09:00.000Z');
      const order = fill({
        status: 'partially_filled',
        quantity: 4,
        filledQuantity: 1,
        filledAt: t1.toISOString(),
      });
      await orders.record(USER, order);
      await orders.record(USER, {
        ...order,
        status: 'filled',
        filledQuantity: 4,
        filledAt: t2.toISOString(),
      });

      expect(prisma.tradeOrders.find((o) => o.id === order.orderId).filledAt).toEqual(t1);
      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.openedAt).toEqual(t1);
    });

    it('stamps the observation time when the broker reports no execution timestamp', async () => {
      const observed = new Date('2026-08-02T14:05:00.000Z');
      jest.useFakeTimers({ now: observed });
      try {
        await orders.record(USER, fill({ filledAt: undefined }));
      } finally {
        jest.useRealTimers();
      }

      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.openedAt).toEqual(observed);
    });

    it('normalizes an offset-bearing broker timestamp to the same UTC instant', async () => {
      // Brokers report execution times in their own zone (SnapTrade's
      // time_executed can carry -05:00). The stored instant — and the ISO
      // UTC string clients receive — must be the same moment, not a
      // wall-clock reading shifted across the boundary.
      await orders.record(USER, fill({ filledAt: '2026-08-02T19:03:00-05:00' }));

      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.openedAt).toEqual(new Date('2026-08-03T00:03:00.000Z'));
      expect(anchor?.openedAt?.toISOString()).toBe('2026-08-03T00:03:00.000Z');
    });

    it('falls back to observation time when the broker timestamp is unparseable', async () => {
      const observed = new Date('2026-08-02T14:05:00.000Z');
      jest.useFakeTimers({ now: observed });
      try {
        await orders.record(USER, fill({ filledAt: 'not-a-timestamp' }));
      } finally {
        jest.useRealTimers();
      }

      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.openedAt).toEqual(observed);
    });

    it('falls back to placement time for legacy rows recorded before fill timestamps', async () => {
      const opening = fill();
      await orders.record(USER, opening);
      // A row persisted before the filledAt column (and the executions
      // table) existed carries neither.
      prisma.tradeOrders.find((o) => o.id === opening.orderId).filledAt = null;
      prisma.tradeOrderExecutions.length = 0;

      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.openedAt).toEqual(new Date(opening.timestamp));
    });

    it('does not anchor a live position on a practice fill', async () => {
      const practiceUser = await prisma.user.create({
        data: { email: 'anchor@example.com', passwordHash: 'h', tradingMode: 'practice' },
      });
      await orders.recordUnderlyingPrice(
        practiceUser.id as string,
        fill({ filledPrice: 1.0 }),
        600,
      );
      // Same user flips to live: the practice fill must not follow them over.
      prisma.users.find((u) => u.id === practiceUser.id).tradingMode = 'live';

      expect(
        await orders.positionAnchors(practiceUser.id as string, [OCC]).then((m) => m.size),
      ).toBe(0);
    });

    it('refuses the entry anchor when the fill was not prompt after placement', async () => {
      // The underlying price is captured when the order is SENT. A resting
      // limit that fills five minutes later did so at a level nobody
      // recorded, and "Move stop to entry" would arm an unattended stop at a
      // price the position never opened at. No anchor is the honest answer —
      // the clients already degrade to no entry line.
      const placed = new Date('2026-08-02T14:00:00.000Z');
      const late = new Date('2026-08-02T14:05:00.000Z');
      await orders.recordUnderlyingPrice(
        USER,
        fill({
          side: 'buy',
          quantity: 1,
          filledPrice: 1.0,
          timestamp: placed.toISOString(),
          filledAt: late.toISOString(),
        }),
        600,
      );

      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.underlyingEntryPrice).toBeUndefined();
      // The opening TIME is still known — only the price is unanchored.
      expect(anchor?.openedAt).toEqual(late);
    });

    it('keeps the entry anchor for a fill that lands promptly after placement', async () => {
      const placed = new Date('2026-08-02T14:00:00.000Z');
      const prompt = new Date('2026-08-02T14:00:03.000Z');
      await orders.recordUnderlyingPrice(
        USER,
        fill({
          side: 'buy',
          quantity: 1,
          filledPrice: 1.0,
          timestamp: placed.toISOString(),
          filledAt: prompt.toISOString(),
        }),
        600,
      );

      expect((await orders.positionAnchors(USER, [OCC])).get(OCC)?.underlyingEntryPrice).toBe(600);
    });

    it('reports the replayed signed quantity, shorts included', async () => {
      await orders.record(USER, fill({ side: 'sell', quantity: 2, filledPrice: 1.5 }));

      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.quantity).toBe(-2);
    });
  });

  describe('execution replay (interleaved partial fills)', () => {
    const t = (s: number) => new Date(1_753_000_000_000 + s * 1000);

    it('replays fills in market order, not placement order', async () => {
      // A resting limit placed FIRST but filled LAST must not replay first:
      // the position opened with the market order's earlier execution.
      await orders.record(
        USER,
        fill({
          orderId: 'REST',
          quantity: 2,
          filledPrice: 1.0,
          timestamp: t(0).toISOString(),
          filledAt: t(100).toISOString(),
        }),
      );
      await orders.record(
        USER,
        fill({
          orderId: 'MKT',
          quantity: 1,
          filledPrice: 1.1,
          timestamp: t(50).toISOString(),
          filledAt: t(50).toISOString(),
        }),
      );

      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.openedAt).toEqual(t(50));
      expect(anchor?.quantity).toBe(3);
    });

    it('anchors openedAt on the execution that reopened the lifecycle, across interleaved partials', async () => {
      // Order X partially fills (opens), order Y's fill flattens the book,
      // X's remaining fill reopens it. Replaying X's cumulative row at its
      // placement slot — the old behavior — reports the FIRST partial as the
      // opening; the true lifecycle reopened at X's second execution.
      const x = fill({
        orderId: 'X',
        status: 'partially_filled',
        quantity: 4,
        filledQuantity: 1,
        filledPrice: 1.0,
        timestamp: t(0).toISOString(),
        filledAt: t(10).toISOString(),
      });
      await orders.record(USER, x);
      await orders.record(
        USER,
        fill({
          orderId: 'Y',
          side: 'sell',
          quantity: 1,
          filledPrice: 1.5,
          timestamp: t(5).toISOString(),
          filledAt: t(20).toISOString(),
        }),
      );
      await orders.record(USER, {
        ...x,
        status: 'filled',
        filledQuantity: 4,
        filledPrice: 1.2,
        filledAt: t(30).toISOString(),
      });

      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.openedAt).toEqual(t(30));
      expect(anchor?.quantity).toBe(3);
    });

    it('records one execution per fill increment and none for a redelivered event', async () => {
      const order = fill({
        orderId: 'DUP',
        status: 'partially_filled',
        quantity: 3,
        filledQuantity: 1,
        filledPrice: 1.0,
        filledAt: t(10).toISOString(),
      });
      await orders.record(USER, order);
      // A webhook redelivery carries the same cumulative state.
      await orders.record(USER, order);
      await orders.record(USER, {
        ...order,
        status: 'filled',
        filledQuantity: 3,
        filledPrice: 1.2,
        filledAt: t(20).toISOString(),
      });

      expect(cumulativesFor('DUP')).toEqual([1, 3]);
    });

    it('derives the increment price from the moving cumulative average', async () => {
      await orders.record(
        USER,
        fill({
          orderId: 'AVG',
          status: 'partially_filled',
          quantity: 3,
          filledQuantity: 1,
          filledPrice: 1.0,
          filledAt: t(10).toISOString(),
        }),
      );
      // A close between the two increments, so the replay has to price them
      // separately — a single full close would net out the same either way.
      await orders.record(
        USER,
        fill({ orderId: 'MID', side: 'sell', filledPrice: 1.5, filledAt: t(20).toISOString() }),
      );
      // Cumulative average moves 1.00 → 1.20 over a 2-lot increment: the
      // increment itself executed at (3·1.20 − 1·1.00) / 2 = 1.30.
      await orders.record(
        USER,
        fill({
          orderId: 'AVG',
          status: 'filled',
          quantity: 3,
          filledQuantity: 3,
          filledPrice: 1.2,
          filledAt: t(30).toISOString(),
        }),
      );
      await orders.record(
        USER,
        fill({
          orderId: 'REST',
          side: 'sell',
          quantity: 2,
          filledPrice: 1.5,
          filledAt: t(40).toISOString(),
        }),
      );

      // Recorded as the observations the broker actually reported…
      expect(prisma.tradeOrderExecutions.map((e) => [e.cumulative, e.avgPrice])).toEqual([
        [1, 1.0],
        [1, 1.5],
        [3, 1.2],
        [2, 1.5],
      ]);
      // …and the 1.30 increment is what the REPLAY derives: (1.50−1.00)×1 +
      // (1.50−1.30)×2, ×100. Pricing the second increment at the 1.20
      // cumulative average instead would report 110.
      expect((await orders.history(USER)).totalRealizedPnl).toBe(90);
    });

    it('never regresses the stored fill on a stale out-of-order event', async () => {
      await orders.record(
        USER,
        fill({
          orderId: 'STALE',
          status: 'filled',
          quantity: 3,
          filledQuantity: 3,
          filledPrice: 1.2,
          filledAt: t(20).toISOString(),
        }),
      );
      // A delayed partial-fill event from earlier in the order's life.
      await orders.record(
        USER,
        fill({
          orderId: 'STALE',
          status: 'partially_filled',
          quantity: 3,
          filledQuantity: 1,
          filledPrice: 1.0,
          filledAt: t(10).toISOString(),
        }),
      );

      const row = prisma.tradeOrders.find((o) => o.id === 'STALE');
      expect(row.filledQuantity).toBe(3);
      expect(row.filledPrice).toBe(1.2);
      expect(row.executedQuantity).toBe(3);
      // The row's cumulative state does not regress — but the late partial is
      // still put ON RECORD, because its price and its moment exist nowhere
      // else and the replay needs them to place the earlier fill.
      expect(cumulativesFor('STALE')).toEqual([1, 3]);
      // Its execution time back-dates filledAt, which anchors openedAt.
      expect(row.filledAt).toEqual(t(10));
    });

    /** A 3-lot buy that fills 1 @1.00 then 2 more (cumulative average 1.20),
     *  with a 1-lot sell @1.50 executing in between. Whatever order the
     *  broker's reports arrive in, the sell closed a lot that cost 1.00 and
     *  the two lots left cost 1.30 — so the sell realizes $50 and a later
     *  exit of the rest at 1.50 realizes $40. */
    const recordInterleavedFill = async (arrival: 'in-order' | 'out-of-order') => {
      const partial = fill({
        orderId: 'OOO',
        status: 'partially_filled' as const,
        quantity: 3,
        filledQuantity: 1,
        filledPrice: 1.0,
        filledAt: t(10).toISOString(),
      });
      const terminal = {
        ...partial,
        status: 'filled' as const,
        filledQuantity: 3,
        filledPrice: 1.2,
        filledAt: t(30).toISOString(),
      };
      const sell = fill({
        orderId: 'MID',
        side: 'sell' as const,
        filledPrice: 1.5,
        filledAt: t(20).toISOString(),
      });
      if (arrival === 'in-order') {
        await orders.record(USER, partial);
        await orders.record(USER, sell);
        await orders.record(USER, terminal);
      } else {
        await orders.record(USER, terminal);
        await orders.record(USER, sell);
        await orders.record(USER, partial);
      }
    };

    it('books an interleaved close the same way whichever order the fills are reported in', async () => {
      // The terminal snapshot arriving before the partial it supersedes used
      // to discard the partial outright, which replayed all 3 lots at the
      // terminal's moment: the sell then opened a phantom SHORT, realized $30
      // instead of $50, and attributed it to the BUY.
      await recordInterleavedFill('out-of-order');

      const history = await orders.history(USER);
      expect(history.totalRealizedPnl).toBe(50);
      expect(history.entries.find((e) => e.orderId === 'MID')?.realizedPnl).toBe(50);
      expect(history.entries.find((e) => e.orderId === 'OOO')?.realizedPnl).toBeNull();
      // The 2 lots still open cost 1.30, not the 1.20 cumulative average.
      await orders.record(
        USER,
        fill({
          orderId: 'EXIT',
          side: 'sell',
          quantity: 2,
          filledPrice: 1.5,
          filledAt: t(40).toISOString(),
        }),
      );
      expect((await orders.history(USER)).totalRealizedPnl).toBe(90);
    });

    it('reports the same book for in-order arrival (the baseline the above must match)', async () => {
      await recordInterleavedFill('in-order');

      const history = await orders.history(USER);
      expect(history.totalRealizedPnl).toBe(50);
      expect(history.entries.find((e) => e.orderId === 'MID')?.realizedPnl).toBe(50);
      expect(cumulativesFor('OOO')).toEqual([1, 3]);
    });

    it('never dates an increment later than a report that already counted it', async () => {
      // Webull reports no execution timestamp, so an observation is stamped
      // when it ARRIVED. The terminal report says cumulative 3 at t+0, which
      // PROVES all three lots executed by then; the partial arriving at t+2
      // is only evidence about how they were split, not about when. So a
      // close at t+1 meets a 3-lot book at the blended 1.20 average.
      const arrival = new Date('2026-08-04T14:00:00.000Z');
      const partial = fill({
        orderId: 'NOTIME',
        status: 'partially_filled' as const,
        quantity: 3,
        filledQuantity: 1,
        filledPrice: 1.0,
        filledAt: undefined,
      });
      jest.useFakeTimers({ now: arrival });
      try {
        await orders.record(USER, {
          ...partial,
          status: 'filled',
          filledQuantity: 3,
          filledPrice: 1.2,
        });
        jest.setSystemTime(new Date(arrival.getTime() + 2000));
        await orders.record(USER, partial);
      } finally {
        jest.useRealTimers();
      }
      await orders.record(
        USER,
        fill({
          orderId: 'BETWEEN',
          side: 'sell',
          filledPrice: 1.5,
          filledAt: new Date(arrival.getTime() + 1000).toISOString(),
        }),
      );

      // (1.50 − 1.20) × 1 × 100. Dating the 2-lot increment at its own
      // arrival would move it past the close and report 50 — a chronology
      // the terminal report rules out.
      expect((await orders.history(USER)).totalRealizedPnl).toBe(30);
    });

    it('still sequences an order’s own fills when they are observed in order', async () => {
      // The same timestamp-less broker, reporting normally: the partial is
      // seen BEFORE the terminal, so each observation genuinely bounds only
      // what had executed by then and the close falls between them.
      const arrival = new Date('2026-08-04T14:00:00.000Z');
      const partial = fill({
        orderId: 'INORDER',
        status: 'partially_filled' as const,
        quantity: 3,
        filledQuantity: 1,
        filledPrice: 1.0,
        filledAt: undefined,
      });
      jest.useFakeTimers({ now: arrival });
      try {
        await orders.record(USER, partial);
        jest.setSystemTime(new Date(arrival.getTime() + 2000));
        await orders.record(USER, {
          ...partial,
          status: 'filled',
          filledQuantity: 3,
          filledPrice: 1.2,
        });
      } finally {
        jest.useRealTimers();
      }
      await orders.record(
        USER,
        fill({
          orderId: 'BETWEEN2',
          side: 'sell',
          filledPrice: 1.5,
          filledAt: new Date(arrival.getTime() + 1000).toISOString(),
        }),
      );

      // Only the 1.00 lot was open when the close landed: (1.50 − 1.00) × 100.
      expect((await orders.history(USER)).totalRealizedPnl).toBe(50);
    });

    it('slots a partial that arrives between two already-recorded snapshots', async () => {
      const base = {
        orderId: 'PERM',
        quantity: 3,
        filledAt: t(10).toISOString(),
      };
      await orders.record(
        USER,
        fill({ ...base, status: 'partially_filled', filledQuantity: 1, filledPrice: 1.0 }),
      );
      await orders.record(
        USER,
        fill({
          ...base,
          status: 'filled',
          filledQuantity: 3,
          filledPrice: 1.2,
          filledAt: t(30).toISOString(),
        }),
      );
      // The middle partial shows up last.
      await orders.record(
        USER,
        fill({
          ...base,
          status: 'partially_filled',
          filledQuantity: 2,
          filledPrice: 1.1,
          filledAt: t(20).toISOString(),
        }),
      );

      expect(cumulativesFor('PERM')).toEqual([1, 2, 3]);
      // Increments 1.00, 1.20, 1.40 — notional 3.60 = 3 × the reported 1.20.
      await orders.record(
        USER,
        fill({
          orderId: 'PERM-EXIT',
          side: 'sell',
          quantity: 3,
          filledPrice: 2.0,
          filledAt: t(40).toISOString(),
        }),
      );
      expect((await orders.history(USER)).totalRealizedPnl).toBe(240);
    });

    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['negative', -1],
      ['zero', 0],
      ['fractional', 1.5],
    ])('quarantines an event whose order quantity is %s', async (_label, quantity) => {
      await orders.record(USER, fill({ orderId: 'BADQ', quantity, filledQuantity: undefined }));

      // Nothing at all was recorded — signed-but-malformed data must not
      // create a row it could later poison.
      expect(prisma.tradeOrders.find((o) => o.id === 'BADQ')).toBeUndefined();
      expect(prisma.tradeOrderExecutions.filter((e) => e.orderId === 'BADQ')).toHaveLength(0);

      // A later well-formed report records normally.
      await orders.record(USER, fill({ orderId: 'BADQ', quantity: 2, filledPrice: 1.0 }));
      expect(prisma.tradeOrders.find((o) => o.id === 'BADQ').executedQuantity).toBe(2);
    });

    it.each([
      ['fractional', 1.5],
      ['negative', -1],
      ['NaN', Number.NaN],
    ])('quarantines an event whose filled quantity is %s', async (_label, filledQuantity) => {
      await orders.record(USER, fill({ orderId: 'BADF', quantity: 3, filledQuantity }));

      expect(prisma.tradeOrders.find((o) => o.id === 'BADF')).toBeUndefined();
      expect(prisma.tradeOrderExecutions.filter((e) => e.orderId === 'BADF')).toHaveLength(0);
    });

    it('quarantines an overfill — cumulative above the order’s own size', async () => {
      await orders.record(
        USER,
        fill({ orderId: 'OVER', quantity: 3, filledQuantity: 5, filledPrice: 1.0 }),
      );

      expect(prisma.tradeOrders.find((o) => o.id === 'OVER')).toBeUndefined();
      expect(prisma.tradeOrderExecutions.filter((e) => e.orderId === 'OVER')).toHaveLength(0);

      // The repaired report is not blocked by the quarantined one.
      await orders.record(
        USER,
        fill({ orderId: 'OVER', quantity: 3, filledQuantity: 3, filledPrice: 1.0 }),
      );
      expect(prisma.tradeOrders.find((o) => o.id === 'OVER').executedQuantity).toBe(3);
    });

    it.each([
      ['zero', 0],
      ['negative', -1.5],
    ])('refuses a %s fill price instead of booking it', async (_label, filledPrice) => {
      await orders.record(USER, fill({ orderId: 'JUNK', quantity: 2, filledPrice }));

      // Nothing is recorded and no authority is claimed, so the junk price
      // can never reach the average-cost book.
      expect(prisma.tradeOrderExecutions.filter((e) => e.orderId === 'JUNK')).toHaveLength(0);
      expect(prisma.tradeOrders.find((o) => o.id === 'JUNK').executedQuantity).toBe(0);
      expect((await orders.positionAnchors(USER, [OCC])).size).toBe(0);

      // A later valid report of the same order still records normally.
      await orders.record(USER, fill({ orderId: 'JUNK', quantity: 2, filledPrice: 1.25 }));
      expect(cumulativesFor('JUNK')).toEqual([2]);
    });

    it('recovers when two attempts fail and the third succeeds', async () => {
      // A transient database failure mid-sequence used to be logged once and
      // dropped, leaving whichever writes had already landed. Retries now
      // back off between attempts, so this rides the awaited ingest path.
      const create = prisma.tradeOrderExecution.create;
      let failuresLeft = 2;
      prisma.tradeOrderExecution.create = async (args: any) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error('connection reset');
        }
        return create(args);
      };
      await events.ingest(
        USER,
        fill({ orderId: 'RETRY', quantity: 2, filledPrice: 1.0, filledAt: t(10).toISOString() }),
      );

      expect(cumulativesFor('RETRY')).toEqual([2]);
      expect((await orders.positionAnchors(USER, [OCC])).get(OCC)?.quantity).toBe(2);
    });

    it('rejects an awaited ingest once every attempt fails, so the webhook can answer 5xx', async () => {
      prisma.tradeOrderExecution.create = async () => {
        throw new Error('database down');
      };

      await expect(
        events.ingest(
          USER,
          fill({ orderId: 'DOWN', quantity: 2, filledPrice: 1.0, filledAt: t(10).toISOString() }),
        ),
      ).rejects.toThrow('database down');
    });

    it('still persists fire-and-forget bus emits (poll and placement paths)', async () => {
      events.emit(
        USER,
        fill({ orderId: 'EMITTED', quantity: 1, filledPrice: 1.0, filledAt: t(10).toISOString() }),
      );
      await new Promise((resolve) => setImmediate(resolve));

      expect(cumulativesFor('EMITTED')).toEqual([1]);
    });

    it('replays a row with no recorded executions from its cumulative state', async () => {
      const legacy = fill({ quantity: 2, filledPrice: 1.1, filledAt: t(10).toISOString() });
      await orders.record(USER, legacy);
      // A row recorded before the executions table existed has no increments.
      prisma.tradeOrderExecutions.length = 0;

      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.openedAt).toEqual(t(10));
      expect(anchor?.quantity).toBe(2);
    });

    it('sums realized P/L across a closing order’s partial executions', async () => {
      await orders.record(
        USER,
        fill({ orderId: 'OPEN', quantity: 2, filledPrice: 1.0, filledAt: t(10).toISOString() }),
      );
      await orders.record(
        USER,
        fill({
          orderId: 'CLOSE',
          side: 'sell',
          status: 'partially_filled',
          quantity: 2,
          filledQuantity: 1,
          filledPrice: 1.5,
          filledAt: t(20).toISOString(),
        }),
      );
      await orders.record(
        USER,
        fill({
          orderId: 'CLOSE',
          side: 'sell',
          status: 'filled',
          quantity: 2,
          filledQuantity: 2,
          filledPrice: 1.5,
          filledAt: t(30).toISOString(),
        }),
      );

      const history = await orders.history(USER);
      const close = history.entries.find((entry) => entry.orderId === 'CLOSE');
      // Two 1-lot closes at 1.50 against a 1.00 basis: 2 × $0.50 × 100.
      expect(close?.realizedPnl).toBe(100);
      expect(history.totalRealizedPnl).toBe(100);
      expect(history.entries).toHaveLength(2);
    });

    it('does not double-record when a stale status regression precedes a redelivered fill', async () => {
      // The round-5 reproduction: filled(1) → stale `submitted` (every
      // mapper's unknown-status fallback) → the same filled(1) redelivered.
      // A watermark derived from status read the regressed row as unfilled
      // and minted a second 1-lot execution — two contracts recorded against
      // a one-lot order.
      const filled = fill({
        orderId: 'REGRESS',
        quantity: 1,
        filledQuantity: 1,
        filledPrice: 1.0,
        filledAt: t(10).toISOString(),
      });
      await orders.record(USER, filled);
      await orders.record(USER, {
        ...filled,
        status: 'submitted',
        filledQuantity: undefined,
        filledPrice: undefined,
        filledAt: undefined,
      });
      await orders.record(USER, filled);

      const row = prisma.tradeOrders.find((o) => o.id === 'REGRESS');
      expect(row.status).toBe('filled');
      expect(row.executedQuantity).toBe(1);
      expect(prisma.tradeOrderExecutions.filter((e) => e.orderId === 'REGRESS')).toHaveLength(1);
      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.quantity).toBe(1);
    });

    it('lets a real fill land over a synthesized cancel (cancel request racing the fill)', async () => {
      // Gateways emit `cancelled` the moment a cancel REQUEST is accepted —
      // before broker truth. When the broker reports the fill actually won,
      // the fill must land: no broker un-fills an order.
      const filled = fill({
        orderId: 'CXL',
        quantity: 1,
        filledQuantity: 1,
        filledPrice: 1.0,
        filledAt: t(10).toISOString(),
      });
      await orders.record(USER, {
        ...filled,
        status: 'cancelled',
        filledQuantity: undefined,
        filledPrice: undefined,
        filledAt: undefined,
      });
      await orders.record(USER, filled);

      const row = prisma.tradeOrders.find((o) => o.id === 'CXL');
      expect(row.status).toBe('filled');
      expect(prisma.tradeOrderExecutions.filter((e) => e.orderId === 'CXL')).toHaveLength(1);
    });

    it('clamps replay to the watermark, so a historical duplicate execution cannot double the book', async () => {
      // Rows written before the watermark existed can carry duplicate
      // increments (the status-regression bug). The replay must trust the
      // row's authority, not the sum of whatever was recorded.
      const filled = fill({
        orderId: 'DUPHIST',
        quantity: 1,
        filledQuantity: 1,
        filledPrice: 1.0,
        filledAt: t(10).toISOString(),
      });
      await orders.record(USER, filled);
      prisma.tradeOrderExecutions.push({
        id: 'dup-exec',
        orderId: 'DUPHIST',
        quantity: 1,
        price: 1.0,
        cumulative: null,
        executedAt: t(11),
        createdAt: new Date(),
      });

      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.quantity).toBe(1);
      const history = await orders.history(USER);
      expect(history.totalRealizedPnl).toBe(0);
    });

    it('keeps the position whole when an observation cannot be stored, and repairs on redelivery', async () => {
      const partial = fill({
        orderId: 'LOST',
        status: 'partially_filled' as const,
        quantity: 2,
        filledQuantity: 1,
        filledPrice: 1.0,
        filledAt: t(10).toISOString(),
      });
      const terminal = {
        ...partial,
        status: 'filled' as const,
        filledQuantity: 2,
        filledPrice: 1.5,
        filledAt: t(20).toISOString(),
      };
      await orders.record(USER, partial);
      const create = prisma.tradeOrderExecution.create;
      let failing = true;
      prisma.tradeOrderExecution.create = async (args: any) => {
        if (failing && args.data.orderId === 'LOST' && args.data.cumulative === 2) {
          throw new Error('connection reset');
        }
        return create(args);
      };
      await expect(orders.record(USER, terminal)).rejects.toThrow('connection reset');

      // The watermark advanced, so the row still vouches for both lots — and
      // the uncovered one is priced at the RESIDUAL (2·1.50 − 1·1.00 = 2.00),
      // which is what makes the book's average equal the broker's 1.50.
      // Pricing it at the cumulative average instead would report 1.25.
      expect((await orders.positionAnchors(USER, [OCC])).get(OCC)?.quantity).toBe(2);
      await orders.record(
        USER,
        fill({
          orderId: 'LOST-EXIT',
          side: 'sell',
          quantity: 2,
          filledPrice: 2.0,
          filledAt: t(30).toISOString(),
        }),
      );
      expect((await orders.history(USER)).totalRealizedPnl).toBe(100);

      // A redelivery puts the missing observation on record, even though its
      // cumulative is no higher than the watermark.
      failing = false;
      await orders.record(USER, terminal);
      expect(cumulativesFor('LOST')).toEqual([1, 2]);
      expect((await orders.history(USER)).totalRealizedPnl).toBe(100);
    });

    it('replays a row carrying the pre-snapshot increment shape', async () => {
      // Rolling deploy: an instance that predates the snapshot columns writes
      // {quantity, price} with no average, and the replay has to recover the
      // curve point from the prefix it extends.
      const base = { orderId: 'MIX', quantity: 3, filledAt: t(10).toISOString() };
      await orders.record(
        USER,
        fill({ ...base, status: 'partially_filled', filledQuantity: 1, filledPrice: 1.0 }),
      );
      const old = prisma.tradeOrderExecutions.find((e) => e.orderId === 'MIX');
      Object.assign(old, { avgPrice: null, quantity: 1, price: 1.0 });
      await orders.record(
        USER,
        fill({
          ...base,
          status: 'filled',
          filledQuantity: 3,
          filledPrice: 1.2,
          filledAt: t(30).toISOString(),
        }),
      );

      // Notional 1×1.00 + 2×1.30 = 3.60; a point read as priceless would book
      // the first lot at 0 and realize 360 below.
      await orders.record(
        USER,
        fill({
          orderId: 'MIX-EXIT',
          side: 'sell',
          quantity: 3,
          filledPrice: 2.0,
          filledAt: t(40).toISOString(),
        }),
      );
      expect((await orders.history(USER)).totalRealizedPnl).toBe(240);
    });

    it('clamps a duplicate left by the status-regression bug even once it carries a cumulative', async () => {
      // The watermark migration backfilled `cumulative` as a running sum, so
      // a historical duplicate is now TWO rows at cumulative 1 and 2 on a
      // one-lot order — self-consistent, and only the row's own watermark
      // says which of them is real.
      await orders.record(
        USER,
        fill({
          orderId: 'DUPCUM',
          quantity: 1,
          filledQuantity: 1,
          filledPrice: 1.0,
          filledAt: t(10).toISOString(),
        }),
      );
      prisma.tradeOrderExecutions.push({
        id: 'dup-backfilled',
        orderId: 'DUPCUM',
        cumulative: 2,
        avgPrice: null,
        quantity: 1,
        price: 1.0,
        executedAt: t(11),
        createdAt: new Date(),
      });

      expect(prisma.tradeOrders.find((o) => o.id === 'DUPCUM').executedQuantity).toBe(1);
      expect((await orders.positionAnchors(USER, [OCC])).get(OCC)?.quantity).toBe(1);
    });

    it('serializes concurrent events for one order (no double-counted increments)', async () => {
      const partial = fill({
        orderId: 'RACE',
        status: 'partially_filled',
        quantity: 3,
        filledQuantity: 1,
        filledPrice: 1.0,
        filledAt: t(10).toISOString(),
      });
      const full = {
        ...partial,
        status: 'filled' as const,
        filledQuantity: 3,
        filledPrice: 1.2,
        filledAt: t(20).toISOString(),
      };
      // Fired together, the way a poll tick and a webhook land.
      await Promise.all([orders.record(USER, partial), orders.record(USER, full)]);

      expect(cumulativesFor('RACE')).toEqual([1, 3]);
      expect((await orders.positionAnchors(USER, [OCC])).get(OCC)?.quantity).toBe(3);
    });
  });

  describe('multi-instance recording (two services over one database)', () => {
    const t = (s: number) => new Date(1_753_000_000_000 + s * 1000);
    let events2: OrderEventsService;
    let orders2: OrdersService;

    beforeEach(() => {
      // A second API instance: its own in-process event bus and record
      // chains, the same database. The per-order promise chain cannot see
      // across this boundary — only the database CAS serializes them.
      events2 = new OrderEventsService();
      orders2 = new OrdersService(
        prisma as unknown as ConstructorParameters<typeof OrdersService>[0],
        events2,
      );
    });

    afterEach(() => {
      orders2.onModuleDestroy();
    });

    it('never double-records an order raced by two instances', async () => {
      const partial = fill({
        orderId: 'MULTI',
        status: 'partially_filled',
        quantity: 3,
        filledQuantity: 1,
        filledPrice: 1.0,
        filledAt: t(10).toISOString(),
      });
      const full = {
        ...partial,
        status: 'filled' as const,
        filledQuantity: 3,
        filledPrice: 1.2,
        filledAt: t(20).toISOString(),
      };
      // The webhook lands on instance B while the poller runs on instance A.
      // Whatever the interleaving, the executions must sum to the broker's
      // cumulative — never 1 + 3 = 4.
      await Promise.all([orders.record(USER, partial), orders2.record(USER, full)]);

      const row = prisma.tradeOrders.find((o) => o.id === 'MULTI');
      expect(row.status).toBe('filled');
      expect(row.executedQuantity).toBe(3);
      const recorded = prisma.tradeOrderExecutions.filter((e) => e.orderId === 'MULTI');
      expect(new Set(recorded.map((e) => e.cumulative)).size).toBe(recorded.length);
      // What the observations mean is the same under every interleaving: the
      // broker's cumulative, booked once.
      expect((await orders.positionAnchors(USER, [OCC])).get(OCC)?.quantity).toBe(3);
    });

    it('records the lower observation without letting it walk the watermark back', async () => {
      // Instance B's terminal snapshot lands first; instance A's earlier
      // partial arrives afterwards. Both are real observations and both must
      // be kept, but the row's cumulative state may only move forward.
      //
      // Monotonicity itself rests on the database: the advance is one
      // statement guarded on `executedQuantity < :cumulative`, and under READ
      // COMMITTED Postgres re-evaluates that predicate against the row the
      // concurrent writer committed, so the lower advance matches nothing.
      // The in-memory double is single-threaded and cannot model that
      // re-check, so this pins the OUTCOME rather than the mechanism.
      const partial = fill({
        orderId: 'LATE',
        status: 'partially_filled',
        quantity: 3,
        filledQuantity: 1,
        filledPrice: 1.0,
        filledAt: t(10).toISOString(),
      });
      await orders2.record(USER, {
        ...partial,
        status: 'filled',
        filledQuantity: 3,
        filledPrice: 1.2,
        filledAt: t(30).toISOString(),
      });
      await orders.record(USER, partial);

      const row = prisma.tradeOrders.find((o) => o.id === 'LATE');
      expect(row.executedQuantity).toBe(3);
      expect(row.filledQuantity).toBe(3);
      expect(row.filledPrice).toBe(1.2);
      expect(cumulativesFor('LATE')).toEqual([1, 3]);
    });

    it('refuses the same increment twice even when the watermark read is ambiguous (unique belt)', async () => {
      // Belt over suspender: even if a recorder somehow re-claimed an
      // already-recorded snapshot, the (orderId, cumulative) constraint
      // refuses the duplicate row — and the recorder treats that as success.
      const filled = fill({
        orderId: 'BELT',
        quantity: 2,
        filledQuantity: 2,
        filledPrice: 1.1,
        filledAt: t(10).toISOString(),
      });
      await orders.record(USER, filled);
      prisma.tradeOrders.find((o) => o.id === 'BELT').executedQuantity = 0;

      await orders2.record(USER, filled);

      const recorded = prisma.tradeOrderExecutions.filter((e) => e.orderId === 'BELT');
      expect(recorded).toHaveLength(1);
      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.quantity).toBe(2);
    });
  });

  describe('cross-tenant containment (two users, one broker order id)', () => {
    const t = (s: number) => new Date(1_753_000_000_000 + s * 1000);
    const USER_B = 'user-2';

    it("refuses another user's event on a colliding id — status, fill state and executions", async () => {
      // Broker order ids are unique only within a brokerage account. User A
      // owns the row; user B's broker happens to reuse the same id.
      await orders.record(
        USER,
        fill({
          orderId: 'SHARED',
          status: 'partially_filled',
          quantity: 3,
          filledQuantity: 1,
          filledPrice: 1.0,
          filledAt: t(10).toISOString(),
        }),
      );
      // B's cumulative (2) is one A's order has NOT recorded, so without the
      // ownership gate the observation dedupe does not save us: the insert
      // keys on orderId alone and B's execution lands on A's book.
      await orders.record(USER_B, {
        ...fill({
          orderId: 'SHARED',
          quantity: 2,
          filledQuantity: 2,
          filledPrice: 9.9,
          filledAt: t(20).toISOString(),
        }),
        side: 'sell',
      });

      const row = prisma.tradeOrders.find((o) => o.id === 'SHARED');
      expect(row.userId).toBe(USER);
      expect(row.status).toBe('partially_filled');
      expect(row.filledPrice).toBe(1.0);
      expect(row.executedQuantity).toBe(1);
      // B's fill minted no execution against A's order — the exact
      // reproduction: the insert keys on orderId alone, so without the
      // ownership gate it would land on A's book.
      expect(cumulativesFor('SHARED')).toEqual([1]);
      const anchorA = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchorA?.quantity).toBe(1);
      expect((await orders.history(USER)).totalRealizedPnl).toBe(0);
    });

    it("refuses another user's underlying price on a colliding id", async () => {
      await orders.recordUnderlyingPrice(
        USER,
        fill({ orderId: 'SHARED2', quantity: 1, filledPrice: 1.0 }),
        600,
      );
      await orders.recordUnderlyingPrice(
        USER_B,
        fill({ orderId: 'SHARED2', quantity: 1, filledPrice: 1.0 }),
        999,
      );

      const row = prisma.tradeOrders.find((o) => o.id === 'SHARED2');
      expect(row.userId).toBe(USER);
      expect(row.underlyingPrice).toBe(600);
      const anchor = (await orders.positionAnchors(USER, [OCC])).get(OCC);
      expect(anchor?.underlyingEntryPrice).toBe(600);
    });
  });

  it("stamps the order with the user's current trading mode", async () => {
    const practiceUser = await prisma.user.create({
      data: { email: 'p@example.com', passwordHash: 'h', tradingMode: 'practice' },
    });
    await orders.record(practiceUser.id as string, fill());
    await orders.record(USER, fill());

    const byUser = (userId: string) => prisma.tradeOrders.find((o) => o.userId === userId);
    expect(byUser(practiceUser.id as string).environment).toBe('practice');
    expect(byUser(USER).environment).toBe('live'); // unknown user → default
  });
});
