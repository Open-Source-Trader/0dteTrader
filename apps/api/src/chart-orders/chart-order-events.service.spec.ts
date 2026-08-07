import { ChartOrder } from '@0dtetrader/shared-types';
import { ChartOrderEventsService } from './chart-order-events.service';

const order = (id: string): ChartOrder => ({
  id,
  underlying: 'SPY',
  optionType: 'call',
  strike: 600,
  expiration: '2026-08-05',
  contractSymbol: 'SPY260805C00600000',
  side: 'sell',
  quantity: 1,
  triggerPrice: 599,
  armPrice: 600,
  kind: 'stop',
  orderType: 'market',
  status: 'working',
  ocoGroupId: null,
  brokerOrderId: null,
  triggeredAt: null,
  lastError: null,
  createdAt: '2026-08-05T14:30:00.000Z',
  expiresAt: '2026-08-05T20:00:00.000Z',
});

describe('ChartOrderEventsService ingestion queue', () => {
  it('serializes delayed fire-and-forget and awaited events per user', async () => {
    const events = new ChartOrderEventsService();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const ingested: string[] = [];
    const published: string[] = [];
    events.registerIngestor(async (event) => {
      if (event.order.id === 'first') await firstBlocked;
      ingested.push(event.order.id);
    });
    events.events$.subscribe((event) => published.push(event.order.id));

    events.emit('user-a', order('first'));
    const second = events.ingest('user-a', order('second'));
    await Promise.resolve();
    await Promise.resolve();
    expect(ingested).toEqual([]);

    releaseFirst();
    await second;
    expect(ingested).toEqual(['first', 'second']);
    expect(published).toEqual(['first', 'second']);
  });

  it('retries an idempotent first chain before allowing the next event', async () => {
    const events = new ChartOrderEventsService();
    const durableKeys = new Set<string>();
    const calls: string[] = [];
    const first = jest.fn(async (event: { order: ChartOrder }) => {
      calls.push(event.order.id);
      durableKeys.add(`${event.order.id}:${event.order.status}`);
    });
    let firstEventAttempts = 0;
    events.registerIngestor(first);
    events.registerIngestor(async (event) => {
      if (event.order.id !== 'one') return;
      firstEventAttempts += 1;
      if (firstEventAttempts === 1) throw new Error('temporary append failure');
    });
    const published: string[] = [];
    events.events$.subscribe((event) => published.push(event.order.id));

    events.emit('user-a', order('one'));
    await events.ingest('user-a', order('two'));

    expect(first).toHaveBeenCalledTimes(3);
    expect(calls).toEqual(['one', 'one', 'two']);
    expect(durableKeys).toEqual(new Set(['one:working', 'two:working']));
    expect(firstEventAttempts).toBe(2);
    expect(published).toEqual(['one', 'two']);
  });
});
