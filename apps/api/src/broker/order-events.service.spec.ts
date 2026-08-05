import { OrderResult } from '@0dtetrader/shared-types';
import { OrderEventsService } from './order-events.service';

const order = (orderId: string): OrderResult => ({
  orderId,
  status: 'submitted',
  contractSymbol: 'SPY260805C00600000',
  side: 'buy',
  quantity: 1,
  orderType: 'market',
  timestamp: '2026-08-05T14:30:00.000Z',
});

describe('OrderEventsService ingestion queue', () => {
  it('does not let awaited ingestion overtake an earlier nonblocking event for the same user', async () => {
    const events = new OrderEventsService();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const ingested: string[] = [];
    const published: string[] = [];
    events.registerIngestor(async (event) => {
      if (event.order.orderId === 'first') await firstBlocked;
      ingested.push(event.order.orderId);
    });
    events.events$.subscribe((event) => published.push(event.order.orderId));

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
    const events = new OrderEventsService();
    const durableKeys = new Set<string>();
    const calls: string[] = [];
    const first = jest.fn(async (event: { order: OrderResult }) => {
      calls.push(event.order.orderId);
      durableKeys.add(event.order.orderId);
    });
    let firstEventAttempts = 0;
    events.registerIngestor(first, 100);
    events.registerIngestor(async (event) => {
      if (event.order.orderId !== 'one') return;
      firstEventAttempts += 1;
      if (firstEventAttempts === 1) throw new Error('temporary\nappend failure');
    });
    const published: string[] = [];
    events.events$.subscribe((event) => published.push(event.order.orderId));

    events.emit('user-a', order('one'));
    await events.ingest('user-a', order('two'));

    expect(first).toHaveBeenCalledTimes(3);
    expect(calls).toEqual(['one', 'one', 'two']);
    expect(durableKeys).toEqual(new Set(['one', 'two']));
    expect(firstEventAttempts).toBe(2);
    expect(published).toEqual(['one', 'two']);
  });

  it('logs bounded single-line exhaustion and then advances the user queue', async () => {
    const events = new OrderEventsService();
    const logger = (
      events as unknown as {
        logger: { warn(message: string): void; error(message: string): void };
      }
    ).logger;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    let attempts = 0;
    events.registerIngestor(async (event) => {
      if (event.order.orderId !== 'bad') return;
      attempts += 1;
      throw new Error(`database\n${'x'.repeat(400)}`);
    });

    await expect(events.ingest('user-a', order('bad'))).rejects.toThrow('database');
    await expect(events.ingest('user-a', order('good'))).resolves.toBeUndefined();

    expect(attempts).toBe(3);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    const logged = String(error.mock.calls[0][0]);
    expect(logged).not.toContain('\n');
    expect(logged.length).toBeLessThan(300);
  });
});
