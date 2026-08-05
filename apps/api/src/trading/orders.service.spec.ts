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

      expect(prisma.tradeOrderExecutions).toHaveLength(2);
      const total = prisma.tradeOrderExecutions.reduce((sum, e) => sum + e.quantity, 0);
      expect(total).toBe(3);
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
          filledAt: t(20).toISOString(),
        }),
      );

      const prices = prisma.tradeOrderExecutions.map((e) => e.price);
      expect(prices[0]).toBeCloseTo(1.0);
      expect(prices[1]).toBeCloseTo(1.3);
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
      expect(prisma.tradeOrderExecutions).toHaveLength(2);
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

    it('replays a late lower cumulative fill before an interleaved close', async () => {
      // Webhook delivery is unordered: cumulative 3 arrives first, but its
      // broker timestamp is after both the first fill and this one-lot close.
      await orders.record(
        USER,
        fill({
          orderId: 'OPEN-OOO',
          quantity: 3,
          filledQuantity: 3,
          filledPrice: 1,
          filledAt: t(30).toISOString(),
        }),
      );
      await orders.record(
        USER,
        fill({
          orderId: 'CLOSE-OOO',
          side: 'sell',
          quantity: 1,
          filledPrice: 1.3,
          filledAt: t(20).toISOString(),
        }),
      );
      await orders.record(
        USER,
        fill({
          orderId: 'OPEN-OOO',
          status: 'partially_filled',
          quantity: 3,
          filledQuantity: 1,
          filledPrice: 0.8,
          filledAt: t(10).toISOString(),
        }),
      );

      const history = await orders.history(USER);
      const close = history.entries.find((entry) => entry.orderId === 'CLOSE-OOO');
      expect(close?.realizedPnl).toBe(50);
    });

    it('rolls back the watermark when execution insertion fails', async () => {
      const event = fill({
        orderId: 'ATOMIC',
        status: 'partially_filled',
        quantity: 2,
        filledQuantity: 1,
      });
      const original = prisma.tradeOrderExecution.create;
      prisma.tradeOrderExecution.create = async () => {
        throw new Error('insert failed');
      };

      await expect(orders.record(USER, event)).rejects.toThrow('insert failed');
      expect(prisma.tradeOrders.find((row) => row.id === 'ATOMIC').executedQuantity).toBe(0);
      expect(prisma.tradeOrderExecutions).toHaveLength(0);

      prisma.tradeOrderExecution.create = original;
      await orders.record(USER, event);
      expect(prisma.tradeOrders.find((row) => row.id === 'ATOMIC').executedQuantity).toBe(1);
      expect(prisma.tradeOrderExecutions).toHaveLength(1);
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
      // Fired together, the way a poll tick and a webhook land: unserialized,
      // both would read cumulative 0 and insert 1 + 3 = 4 lots of increments.
      await Promise.all([orders.record(USER, partial), orders.record(USER, full)]);

      const total = prisma.tradeOrderExecutions.reduce((sum, e) => sum + e.quantity, 0);
      expect(total).toBe(3);
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
      expect(recorded.reduce((sum, e) => sum + e.quantity, 0)).toBe(3);
      expect(new Set(recorded.map((e) => e.cumulative)).size).toBe(recorded.length);
    });

    it('retries the advance when the other instance claims the watermark mid-flight', async () => {
      const partial = fill({
        orderId: 'CAS',
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
      // Seed the row so both recorders go straight to the fill path.
      await orders.record(USER, {
        ...partial,
        status: 'submitted',
        filledQuantity: undefined,
        filledPrice: undefined,
        filledAt: undefined,
      });

      // Hold instance B on its FIRST watermark read — a pre-advance snapshot
      // — until instance A's advance has fully committed. B's compare-and-set
      // is then guaranteed the count-0 → re-read → retry branch; without the
      // gate the interleaving (and which branch runs) is scheduler luck.
      const original = prisma.tradeOrder.findUnique;
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let reachedHold!: () => void;
      const holding = new Promise<void>((resolve) => {
        reachedHold = resolve;
      });
      prisma.tradeOrder.findUnique = async (args: any) => {
        prisma.tradeOrder.findUnique = original; // one-shot: later reads pass
        const row = await original(args);
        reachedHold();
        await gate;
        return row;
      };

      const recordedByB = orders2.record(USER, full);
      await holding; // B holds executedQuantity = 0
      await orders.record(USER, partial); // A advances 0 → 1
      releaseGate();
      await recordedByB; // B: CAS(0) misses, re-reads 1, advances 1 → 3

      const row = prisma.tradeOrders.find((o) => o.id === 'CAS');
      expect(row.executedQuantity).toBe(3);
      const recorded = prisma.tradeOrderExecutions
        .filter((e) => e.orderId === 'CAS')
        .sort((a, b) => a.cumulative - b.cumulative);
      expect(recorded.map((e) => e.quantity)).toEqual([1, 2]);
      expect(recorded.map((e) => e.cumulative)).toEqual([1, 3]);
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
