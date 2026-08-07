import { EventEmitter } from 'node:events';
import { createClient } from 'redis';
import {
  AppKeyRateLimiter,
  DistributedRateLease,
  RateLimiterUnavailableError,
  RedisRateLease,
} from './order-book-rate-limiter';

jest.mock('redis', () => ({ createClient: jest.fn() }));

function redisClient(overrides: Record<string, unknown> = {}) {
  const client = Object.assign(new EventEmitter(), {
    isOpen: false,
    isReady: false,
    connect: jest.fn(async () => undefined),
    set: jest.fn(async () => 'OK'),
    withAbortSignal: jest.fn(),
    quit: jest.fn(async () => 'OK'),
    destroy: jest.fn(),
    ...overrides,
  });
  client.withAbortSignal.mockReturnValue(client);
  return client;
}

describe('AppKeyRateLimiter', () => {
  it('serializes grants across limiter instances sharing the distributed lease', async () => {
    let now = 0;
    const expiries = new Map<string, number>();
    const grants: number[] = [];
    const lease: DistributedRateLease = {
      tryAcquire: jest.fn(async (key, ttlMs) => {
        if ((expiries.get(key) ?? 0) > now) return false;
        expiries.set(key, now + ttlMs);
        grants.push(now);
        return true;
      }),
    };
    const sleep = async (ms: number) => {
      now += ms;
    };
    const first = new AppKeyRateLimiter(lease, { now: () => now, sleep });
    const second = new AppKeyRateLimiter(lease, { now: () => now, sleep });

    await expect(
      Promise.all([first.acquire('app-key'), second.acquire('app-key')]),
    ).resolves.toEqual([
      { waitedMs: 0, denials: 0 },
      { waitedMs: 1_000, denials: 1 },
    ]);
    expect(grants).toEqual([0, 1_000]);
    for (const [key] of (lease.tryAcquire as jest.Mock).mock.calls) {
      expect(key).toMatch(/^l2:rate:[a-f0-9]{64}$/);
      expect(key).not.toContain('app-key');
    }
  });

  it('fails closed when the distributed authority is unavailable', async () => {
    const lease: DistributedRateLease = {
      tryAcquire: jest.fn(async () => Promise.reject(new Error('redis down'))),
    };
    const limiter = new AppKeyRateLimiter(lease, { now: () => 0, sleep: async () => undefined });
    await expect(limiter.acquire('app-key')).rejects.toBeInstanceOf(RateLimiterUnavailableError);
  });

  it('fails closed without attempting a default localhost Redis connection', async () => {
    const lease = new RedisRateLease({ get: jest.fn(() => '') } as never);
    await expect(lease.tryAcquire('l2:rate:key', 1_000)).rejects.toThrow('REDIS_URL is required');
  });

  it('handles a live Redis error event instead of allowing an unhandled process error', () => {
    const client = redisClient();
    jest.mocked(createClient).mockReturnValueOnce(client as never);
    new RedisRateLease({
      get: jest.fn((key: string) =>
        key === 'redis.url' ? 'redis://example.test:6379' : undefined,
      ),
    } as never);

    expect(() => client.emit('error', new Error('socket closed'))).not.toThrow();
  });

  it('passes cancellation through the distributed lease attempt', async () => {
    let leaseSignal: AbortSignal | undefined;
    const lease: DistributedRateLease = {
      tryAcquire: jest.fn(async (_key, _ttlMs, signal?: AbortSignal) => {
        leaseSignal = signal;
        return false;
      }),
    };
    const limiter = new AppKeyRateLimiter(lease, { now: () => 0 });
    const controller = new AbortController();
    const pending = limiter.acquire('app-key', controller.signal);
    await Promise.resolve();

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(leaseSignal).toBe(controller.signal);
  });

  it('aborts a Redis connect that has not completed', async () => {
    const client = redisClient({ connect: jest.fn(() => new Promise<void>(() => undefined)) });
    jest.mocked(createClient).mockReturnValueOnce(client as never);
    const lease = new RedisRateLease({
      get: jest.fn((key: string) => {
        if (key === 'redis.url') return 'redis://example.test:6379';
        if (key === 'redis.operationTimeoutMs') return 5_000;
        return undefined;
      }),
    } as never);
    const controller = new AbortController();
    const pending = (
      lease.tryAcquire as unknown as (
        key: string,
        ttlMs: number,
        signal?: AbortSignal,
      ) => Promise<boolean>
    )('l2:rate:key', 1_000, controller.signal);

    controller.abort();

    const outcome = await Promise.race([
      pending.then(
        () => ({ name: 'resolved' }),
        (error: unknown) => error,
      ),
      new Promise<{ name: string }>((resolve) => setImmediate(() => resolve({ name: 'pending' }))),
    ]);
    expect(outcome).toMatchObject({ name: 'AbortError' });
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it('bounds a Redis SET that never receives a reply', async () => {
    jest.useFakeTimers();
    try {
      const client = redisClient({
        isOpen: true,
        isReady: true,
        set: jest.fn(() => new Promise<string>(() => undefined)),
      });
      jest.mocked(createClient).mockReturnValueOnce(client as never);
      const lease = new RedisRateLease({
        get: jest.fn((key: string) => {
          if (key === 'redis.url') return 'redis://example.test:6379';
          if (key === 'redis.operationTimeoutMs') return 250;
          return undefined;
        }),
      } as never);
      let outcome: unknown;
      void lease.tryAcquire('l2:rate:key', 1_000).catch((error) => {
        outcome = error;
      });

      await jest.advanceTimersByTimeAsync(250);

      expect(outcome).toMatchObject({ name: 'TimeoutError' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels a denied rate wait when its final subscriber disappears', async () => {
    jest.useFakeTimers();
    try {
      const lease: DistributedRateLease = { tryAcquire: jest.fn(async () => false) };
      const limiter = new AppKeyRateLimiter(lease, { now: () => 0 });
      const controller = new AbortController();
      const pending = limiter.acquire('app-key', controller.signal);
      await Promise.resolve();

      expect(jest.getTimerCount()).toBe(1);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(lease.tryAcquire).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports every denied distributed slot immediately, even when cancelled before a grant', async () => {
    jest.useFakeTimers();
    const lease: DistributedRateLease = { tryAcquire: jest.fn(async () => false) };
    const limiter = new AppKeyRateLimiter(lease, { now: () => 0 });
    const controller = new AbortController();
    const denied = jest.fn();
    const pending = limiter.acquire('app-key', controller.signal, denied);
    await Promise.resolve();

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(denied).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
});
