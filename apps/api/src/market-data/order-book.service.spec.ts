import { OrderBookProviderResult } from './order-book.provider';
import { AppKeyRateLimiter, DistributedRateLease } from './order-book-rate-limiter';
import { OrderBookService } from './order-book.service';

const flush = async () => {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
};

function available(second: number, bidSize = 10, askSize = 8): OrderBookProviderResult {
  return {
    availability: 'available',
    snapshot: {
      symbol: 'SPY',
      provider: 'webull',
      capability: 'nasdaq_totalview_non_display',
      freshness: 'fresh',
      timestamp: `2026-08-05T14:30:${String(second).padStart(2, '0')}.000Z`,
      receivedAt: `2026-08-05T14:30:${String(second).padStart(2, '0')}.100Z`,
      depth: 1,
      bids: [{ price: 100, size: bidSize }],
      asks: [{ price: 101, size: askSize }],
    },
  };
}

function availableAt(
  timestamp: string,
): Extract<OrderBookProviderResult, { availability: 'available' }> {
  const result = available(0);
  if (result.availability !== 'available') throw new Error('test fixture must be available');
  return { availability: 'available', snapshot: { ...result.snapshot, timestamp } };
}

describe('OrderBookService lifecycle', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-08-05T14:30:00.000Z')));
  afterEach(() => jest.useRealTimers());

  it('coalesces subscribers and refreshes once per symbol while independently faning out', async () => {
    const provider = { appKey: 'key', fetch: jest.fn(async () => available(0)) };
    const limiter = { acquire: jest.fn(async () => undefined) };
    const service = new OrderBookService(provider, limiter, { pollMs: 1_000, staleMs: 5_000 });
    const first = jest.fn();
    const second = jest.fn();

    service.subscribe('a', 'SPY', 5, first);
    service.subscribe('b', 'SPY', 10, second);
    await flush();
    expect(provider.fetch).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith(expect.objectContaining({ type: 'l2Snapshot' }));
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ type: 'l2Snapshot' }));

    await jest.advanceTimersByTimeAsync(1_000);
    expect(provider.fetch).toHaveBeenCalledTimes(2);
    expect(limiter.acquire).toHaveBeenCalledTimes(2);
  });

  it('immediately replays the current fresh snapshot to an active join without starting another request', async () => {
    const provider = { appKey: 'key', fetch: jest.fn(async () => available(0)) };
    const service = new OrderBookService(provider, { acquire: async () => undefined });
    service.subscribe('a', 'SPY', 5, jest.fn());
    await flush();
    const joined = jest.fn();

    service.subscribe('b', 'SPY', 5, joined);

    expect(joined).toHaveBeenCalledWith(expect.objectContaining({ type: 'l2Snapshot' }));
    expect(provider.fetch).toHaveBeenCalledTimes(1);
    expect(service.diagnostics().subscribers).toBe(2);
  });

  it('does not call Redis or Webull outside the official New York regular session', async () => {
    const provider = { appKey: 'key', fetch: jest.fn(async () => available(0)) };
    const limiter = { acquire: jest.fn(async () => undefined) };
    const listener = jest.fn();
    const service = new OrderBookService(provider, limiter, {
      now: () => Date.parse('2026-08-05T22:00:00.000Z'),
    });

    service.subscribe('a', 'SPY', 5, listener);
    await flush();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'market_closed' }),
      }),
    );
    expect(limiter.acquire).not.toHaveBeenCalled();
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['spring DST', '2026-03-09T13:30:00.500Z', '2026-03-09T13:29:59.500Z'],
    ['fall DST', '2026-11-02T14:30:00.500Z', '2026-11-02T14:29:59.500Z'],
  ])(
    'rejects a current snapshot timestamped before the official %s-adjusted RTH open',
    async (_label, receiptTimestamp, providerTimestamp) => {
      jest.setSystemTime(new Date(receiptTimestamp));
      const listener = jest.fn();
      const provider = {
        appKey: 'key',
        fetch: jest.fn(async () => availableAt(providerTimestamp)),
      };
      const service = new OrderBookService(provider, { acquire: async () => undefined });

      service.subscribe('a', 'SPY', 5, listener);
      await flush();

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'l2Status',
          data: expect.objectContaining({ reason: 'market_closed', retryable: true }),
        }),
      );
      expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'l2Snapshot' }));
      expect(service.diagnostics()).toMatchObject({ historySamples: 0 });
    },
  );

  it('uses bounded exponential retry delays for retryable failures and resets after success', async () => {
    let calls = 0;
    const provider = {
      appKey: 'key',
      fetch: jest.fn(async (): Promise<OrderBookProviderResult> => {
        calls += 1;
        if (calls < 4) {
          return {
            availability: 'unavailable',
            status: {
              availability: 'unavailable',
              symbol: 'SPY',
              provider: 'webull',
              capability: 'nasdaq_totalview_non_display',
              freshness: null,
              reason: 'provider_error',
              message: 'retry',
              retryable: true,
            },
          };
        }
        return available(3);
      }),
    };
    const service = new OrderBookService(
      provider,
      { acquire: async () => undefined },
      {
        pollMs: 1_000,
        maxRetryMs: 30_000,
      },
    );
    service.subscribe('a', 'SPY', 5, jest.fn());
    await flush();
    await jest.advanceTimersByTimeAsync(999);
    expect(provider.fetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(provider.fetch).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1_999);
    expect(provider.fetch).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(provider.fetch).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(4_000);
    expect(provider.fetch).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(provider.fetch).toHaveBeenCalledTimes(5);
  });

  it('resets bounded history at the New York day boundary and exposes resource counts', async () => {
    const nextDay = availableAt('2026-08-06T14:30:00.000Z');
    const provider = {
      appKey: 'key',
      fetch: jest
        .fn<Promise<OrderBookProviderResult>, []>()
        .mockResolvedValueOnce(available(0))
        .mockResolvedValueOnce(available(1))
        .mockResolvedValueOnce(nextDay),
    };
    const listener = jest.fn();
    const service = new OrderBookService(
      provider,
      { acquire: async () => undefined },
      {
        pollMs: 1_000,
        maxHistory: 2,
      },
    );
    service.subscribe('a', 'SPY', 5, listener);
    await flush();
    await jest.advanceTimersByTimeAsync(2_000);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reason: 'no_data',
          message: expect.stringContaining('session'),
        }),
      }),
    );
    expect(service.diagnostics()).toMatchObject({ historySamples: 1, subscribers: 1 });
    const snapshots = listener.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === 'l2Snapshot');
    expect(snapshots[snapshots.length - 1].data.indicators.spreadPercentile).toBeNull();
  });

  it('keeps work for partial unsubscribe and tears down on final unsubscribe/disconnect', async () => {
    const provider = { appKey: 'key', fetch: jest.fn(async () => available(0)) };
    const service = new OrderBookService(
      provider,
      { acquire: async () => undefined },
      { pollMs: 1_000, staleMs: 5_000 },
    );
    service.subscribe('a', 'SPY', 5, jest.fn());
    service.subscribe('b', 'SPY', 5, jest.fn());
    await flush();
    service.unsubscribe('a', 'SPY');
    await jest.advanceTimersByTimeAsync(1_000);
    expect(provider.fetch).toHaveBeenCalledTimes(2);
    service.disconnect('b');
    await jest.advanceTimersByTimeAsync(5_000);
    expect(provider.fetch).toHaveBeenCalledTimes(2);
    expect(service.diagnostics()).toMatchObject({ symbols: 0, subscribers: 0, timers: 0 });
  });

  it('clears a denied distributed-rate wait timer during service shutdown', async () => {
    const lease: DistributedRateLease = { tryAcquire: jest.fn(async () => false) };
    const limiter = new AppKeyRateLimiter(lease, { now: () => Date.now() });
    const service = new OrderBookService({ appKey: 'key', fetch: jest.fn() }, limiter);

    service.subscribe('a', 'SPY', 5, jest.fn());
    await flush();
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    service.destroy();
    await flush();

    expect(service.diagnostics()).toMatchObject({ symbols: 0, cleanupPending: 0 });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('discards superseded in-flight results after final teardown', async () => {
    let resolve!: (value: OrderBookProviderResult) => void;
    const provider = {
      appKey: 'key',
      fetch: jest.fn(
        () =>
          new Promise<OrderBookProviderResult>((done) => {
            resolve = done;
          }),
      ),
    };
    const listener = jest.fn();
    const service = new OrderBookService(provider, { acquire: async () => undefined });
    service.subscribe('a', 'SPY', 5, listener);
    await flush();
    service.unsubscribe('a', 'SPY');
    resolve(available(0));
    await flush();
    expect(listener).not.toHaveBeenCalled();
    expect(service.diagnostics()).toMatchObject({ symbols: 0, inFlight: 0 });
  });

  it('cancels a distributed rate wait on final unsubscribe before any provider call', async () => {
    let signal: AbortSignal | undefined;
    const limiter = {
      acquire: jest.fn((_key: string, candidate?: AbortSignal) => {
        signal = candidate;
        return new Promise<void>((_resolve, reject) => {
          candidate?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })),
            { once: true },
          );
        });
      }),
    };
    const provider = { appKey: 'key', fetch: jest.fn(async () => available(0)) };
    const service = new OrderBookService(provider, limiter);
    service.subscribe('a', 'SPY', 5, jest.fn());
    await flush();

    service.unsubscribe('a', 'SPY');
    await flush();

    expect(signal?.aborted).toBe(true);
    expect(provider.fetch).not.toHaveBeenCalled();
    expect(service.diagnostics()).toMatchObject({ symbols: 0, timers: 0, inFlight: 0 });
  });

  it('retains subscribers and retries a retryable capability probe result', async () => {
    let attempts = 0;
    const provider = {
      appKey: 'key',
      preflight: jest.fn(() => {
        attempts += 1;
        return attempts === 1
          ? {
              availability: 'unavailable' as const,
              status: {
                availability: 'unavailable' as const,
                symbol: 'SPY',
                provider: 'webull' as const,
                capability: 'nasdaq_totalview_non_display' as const,
                freshness: null,
                reason: 'provider_error' as const,
                message: 'probe failed',
                retryable: true,
              },
            }
          : null;
      }),
      fetch: jest.fn(async () => available(0)),
    };
    const service = new OrderBookService(
      provider,
      { acquire: async () => undefined },
      { pollMs: 1_000 },
    );
    service.subscribe('a', 'SPY', 5, jest.fn());
    await flush();
    expect(service.diagnostics().subscribers).toBe(1);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(provider.fetch).toHaveBeenCalledTimes(1);
  });

  it('classifies an unexpected provider exception separately from Redis failure and records metrics', async () => {
    const listener = jest.fn();
    const service = new OrderBookService(
      { appKey: 'key', fetch: jest.fn(async () => Promise.reject(new Error('provider exploded'))) },
      { acquire: jest.fn(async () => 125) },
      {
        monotonicNow: (() => {
          let value = 10;
          return () => (value += 5);
        })(),
      },
    );

    service.subscribe('a', 'SPY', 5, listener);
    await flush();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'provider_error' }),
      }),
    );
    expect(listener).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'rate_limiter_unavailable' }),
      }),
    );
    expect((service as unknown as { metrics: Record<string, number> }).metrics).toMatchObject({
      throttleDelayMs: 125,
      providerErrors: 1,
      providerLatencyMs: expect.any(Number),
    });
  });

  it('marks a previously live snapshot stale at five seconds and continues retrying', async () => {
    let calls = 0;
    const provider = {
      appKey: 'key',
      fetch: jest.fn(async () => {
        calls += 1;
        return calls === 1 ? available(0) : new Promise<OrderBookProviderResult>(() => undefined);
      }),
    };
    const listener = jest.fn();
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const service = new OrderBookService(
      provider,
      { acquire: async () => undefined },
      { pollMs: 1_000, staleMs: 5_000, logger },
    );
    service.subscribe('a', 'SPY', 5, listener);
    await flush();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'l2Status',
        data: expect.objectContaining({ reason: 'stale', freshness: 'stale' }),
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('l2_stale'));
  });

  it('expires freshness five seconds after the provider timestamp, not five seconds after receipt', async () => {
    jest.setSystemTime(new Date('2026-08-05T14:30:04.000Z'));
    const listener = jest.fn();
    const service = new OrderBookService(
      { appKey: 'key', fetch: jest.fn(async () => available(0)) },
      { acquire: async () => undefined },
      { pollMs: 60_000, staleMs: 5_000 },
    );

    service.subscribe('a', 'SPY', 5, listener);
    await flush();
    await jest.advanceTimersByTimeAsync(999);
    expect(listener).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'stale' }),
      }),
    );
    await jest.advanceTimersByTimeAsync(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'stale' }),
      }),
    );
  });

  it.each([
    ['spring forward', '2026-03-08T05:00:00.000Z', 23 * 60 * 60 * 1_000],
    ['fall back', '2026-11-01T04:00:00.000Z', 25 * 60 * 60 * 1_000],
  ])('resets at the next New York midnight across %s', async (_label, start, duration) => {
    jest.setSystemTime(new Date(start));
    const listener = jest.fn();
    const preflight = jest.fn(() => null);
    const service = new OrderBookService(
      { appKey: 'key', preflight, fetch: jest.fn() },
      { acquire: jest.fn() },
      { pollMs: 1_000_000_000, maxRetryMs: 1_000_000_000 },
    );
    service.subscribe('a', 'SPY', 5, listener);
    await flush();
    listener.mockClear();

    await jest.advanceTimersByTimeAsync(duration - 1);
    expect(listener).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ message: expect.stringContaining('session') }),
      }),
    );
    await jest.advanceTimersByTimeAsync(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reason: 'no_data',
          message: expect.stringContaining('session'),
        }),
      }),
    );
    expect(preflight).toHaveBeenCalledTimes(2);
  });

  it.each(['waiting for Redis', 'fetching Webull'] as const)(
    'cancels and discards old work at the NY boundary while %s',
    async (phase) => {
      jest.setSystemTime(new Date('2026-08-05T14:30:00.000Z'));
      let signal: AbortSignal | undefined;
      const cancelled = () => Object.assign(new Error('cancelled'), { name: 'AbortError' });
      const limiter = {
        acquire: jest.fn((_key: string, candidate?: AbortSignal) => {
          if (phase === 'fetching Webull') return Promise.resolve(undefined);
          signal = candidate;
          return new Promise<void>((_resolve, reject) => {
            candidate?.addEventListener('abort', () => reject(cancelled()), { once: true });
          });
        }),
      };
      const provider = {
        appKey: 'key',
        preflight: jest.fn(() => null),
        fetch: jest.fn((_symbol: string, _levels: number, candidate?: AbortSignal) => {
          signal = candidate;
          return new Promise<OrderBookProviderResult>((_resolve, reject) => {
            candidate?.addEventListener('abort', () => reject(cancelled()), { once: true });
          });
        }),
      };
      const listener = jest.fn();
      const service = new OrderBookService(provider, limiter);
      service.subscribe('a', 'SPY', 5, listener);
      await flush();

      await jest.advanceTimersByTimeAsync(13.5 * 60 * 60 * 1_000);
      await flush();

      expect(signal?.aborted).toBe(true);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            reason: 'no_data',
            message: expect.stringContaining('session'),
          }),
        }),
      );
      expect(provider.preflight).toHaveBeenCalledTimes(2);
      expect(service.diagnostics().cleanupPending).toBe(0);
    },
  );

  it('aborts an in-flight provider request and reports cleanup until it actually settles', async () => {
    let signal: AbortSignal | undefined;
    let rejectFetch!: (error: Error) => void;
    const fetch = jest.fn((_symbol: string, _levels: number, candidate?: AbortSignal) => {
      signal = candidate;
      return new Promise<OrderBookProviderResult>((_resolve, reject) => {
        rejectFetch = reject;
      });
    });
    const service = new OrderBookService(
      { appKey: 'key', fetch } as never,
      { acquire: async () => undefined },
      { cleanupGraceMs: 1_000 } as never,
    );
    service.subscribe('a', 'SPY', 5, jest.fn());
    await flush();

    service.unsubscribe('a', 'SPY');

    expect(signal?.aborted).toBe(true);
    expect(service.diagnostics()).toMatchObject({ symbols: 0, inFlight: 1, cleanupPending: 1 });
    rejectFetch(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    await flush();
    expect(service.diagnostics()).toMatchObject({ inFlight: 0, cleanupPending: 0 });
  });

  it('records and logs cleanup work that does not settle within the grace period', async () => {
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const service = new OrderBookService(
      {
        appKey: 'key',
        fetch: jest.fn(() => new Promise<OrderBookProviderResult>(() => undefined)),
      },
      { acquire: async () => undefined },
      { cleanupGraceMs: 1_000, logger },
    );
    service.subscribe('a', 'SPY', 5, jest.fn());
    await flush();

    service.unsubscribe('a', 'SPY');
    await jest.advanceTimersByTimeAsync(1_000);

    expect(service.metrics.cleanupLeaks).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('l2_cleanup_pending'));
    expect(service.diagnostics().cleanupPending).toBe(1);
  });

  it('exports complete L2 metrics and structured operational logs', async () => {
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const listener = jest.fn();
    const result = available(0) as Extract<
      OrderBookProviderResult,
      { availability: 'available' }
    > & {
      decoderTimeMs: number;
    };
    result.decoderTimeMs = 3;
    const service = new OrderBookService(
      { appKey: 'key', fetch: jest.fn(async () => result) },
      {
        acquire: jest.fn(async (_key, _signal, onDenied: (count?: number) => void) => {
          onDenied(2);
          return { waitedMs: 125, denials: 2 };
        }),
      } as never,
      { logger } as never,
    );

    service.subscribe('a', 'SPY', 5, listener);
    service.subscribe('b', 'SPY', 5, jest.fn());
    await flush();
    service.unsubscribe('b', 'SPY');

    expect((service as unknown as { metrics: Record<string, number> }).metrics).toMatchObject({
      activeSymbolGauge: 1,
      subscriberGauge: 1,
      rateGrants: 1,
      rateDenials: 2,
      throttleDelayMs: 125,
      decoderTimeMs: 3,
      cleanupLeaks: 0,
    });
    for (const event of [
      'l2_subscribed',
      'l2_coalesced',
      'l2_rate_wait',
      'l2_snapshot_published',
      'l2_unsubscribed',
    ]) {
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining(event));
    }
    service.destroy();
    expect((service.metrics as unknown as Record<string, number>).activeSymbolGauge).toBe(0);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('"reason":"shutdown"'));
  });

  it('clears terminal failures, reports rate authority failure, bounds state, and measures payloads', async () => {
    const entitlement: OrderBookProviderResult = {
      availability: 'unavailable',
      status: {
        availability: 'unavailable',
        symbol: 'SPY',
        provider: 'webull',
        capability: 'nasdaq_totalview_non_display',
        freshness: null,
        reason: 'entitlement_missing',
        message: 'missing',
        retryable: false,
      },
    };
    const listener = jest.fn();
    const entitlementLogger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const service = new OrderBookService(
      { appKey: 'key', fetch: jest.fn(async () => entitlement) },
      { acquire: async () => undefined },
      { maxSymbols: 1, logger: entitlementLogger },
    );
    service.subscribe('a', 'SPY', 5, listener);
    await flush();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'l2Status' }));
    expect(service.diagnostics().symbols).toBe(0);
    expect(entitlementLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('l2_entitlement_unavailable'),
    );

    const rateListener = jest.fn();
    const rateService = new OrderBookService(
      { appKey: 'key', fetch: jest.fn() },
      { acquire: async () => Promise.reject(new Error('redis down')) },
      { maxSymbols: 1 },
    );
    rateService.subscribe('a', 'SPY', 5, rateListener);
    rateService.subscribe('b', 'QQQ', 5, rateListener);
    await flush();
    expect(rateListener).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'rate_limiter_unavailable' }),
      }),
    );
    expect(rateListener).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'no_data', retryable: false }),
      }),
    );
    expect((rateService as unknown as { metrics: Record<string, number> }).metrics).toMatchObject({
      requests: 0,
      unavailable: expect.any(Number),
    });
  });
});
