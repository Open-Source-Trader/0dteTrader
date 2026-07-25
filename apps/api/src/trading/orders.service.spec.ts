import { OrderResult } from '@0dtetrader/shared-types';
import { OrderEventsService } from '../broker/order-events.service';
import { InMemoryPrismaService } from '../../test/in-memory-prisma.service';
import { OrdersService } from './orders.service';

const USER = 'user-1';
const OCC = 'SPY260717C00505000';

let orderSeq = 0;

function fill(overrides: Partial<OrderResult> = {}): OrderResult {
  orderSeq += 1;
  return {
    orderId: `O-${orderSeq}`,
    status: 'filled',
    contractSymbol: OCC,
    side: 'buy',
    quantity: 1,
    orderType: 'market',
    filledPrice: 1.0,
    timestamp: new Date(1_752_000_000_000 + orderSeq * 60_000).toISOString(),
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
      expect(await orders.positionAnchors(USER, [OCC])).toEqual(new Map([[OCC, 603]]));
    });

    it('omits a contract whose fills carry no underlying price', async () => {
      // Opened before the column existed, or outside the app.
      await orders.record(USER, fill({ side: 'buy', quantity: 1, filledPrice: 1.0 }));

      expect(await orders.positionAnchors(USER, [OCC]).then((m) => m.size)).toBe(0);
    });

    it('blends only the fills that reported a price, never averaging a missing one in as zero', async () => {
      await orders.record(USER, fill({ side: 'buy', quantity: 1, filledPrice: 1.0 }));
      await orders.recordUnderlyingPrice(
        USER,
        fill({ side: 'buy', quantity: 1, filledPrice: 1.0 }),
        604,
      );

      expect(await orders.positionAnchors(USER, [OCC])).toEqual(new Map([[OCC, 604]]));
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

      expect(await orders.positionAnchors(USER, [OCC])).toEqual(new Map([[OCC, 605]]));
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
      expect(await orders.positionAnchors(USER, [OCC])).toEqual(new Map([[OCC, 612.5]]));
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
      expect(await orders.positionAnchors(USER, [OCC])).toEqual(new Map([[OCC, 610]]));
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

      expect(await orders.positionAnchors(USER, [other])).toEqual(new Map([[other, 500]]));
      expect(await orders.positionAnchors(USER, [])).toEqual(new Map());
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
