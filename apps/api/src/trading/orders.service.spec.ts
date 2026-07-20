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
