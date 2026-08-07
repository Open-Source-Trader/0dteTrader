import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { createClient } from 'redis';

export interface DistributedRateLease {
  tryAcquire(key: string, ttlMs: number, signal?: AbortSignal): Promise<boolean>;
}

export interface AppKeyRateLimiterOptions {
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  intervalMs?: number;
}

export interface AppKeyRateLimitGrant {
  waitedMs: number;
  denials: number;
}

export class RateLimiterUnavailableError extends Error {
  constructor() {
    super('The distributed Level 2 rate limiter is unavailable.');
    this.name = 'RateLimiterUnavailableError';
  }
}

export class AppKeyRateLimiter {
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly intervalMs: number;

  constructor(
    private readonly lease: DistributedRateLease,
    options: AppKeyRateLimiterOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? abortableSleep;
    this.intervalMs = options.intervalMs ?? 1_000;
  }

  async acquire(
    appKey: string,
    signal?: AbortSignal,
    onDenied?: (count?: number) => void,
  ): Promise<AppKeyRateLimitGrant> {
    const appKeyDigest = createHash('sha256').update(appKey).digest('hex');
    const key = `l2:rate:${appKeyDigest}`;
    let waitedMs = 0;
    let denials = 0;
    for (;;) {
      if (signal?.aborted) throw aborted();
      try {
        if (await this.lease.tryAcquire(key, this.intervalMs, signal)) return { waitedMs, denials };
      } catch {
        if (signal?.aborted) throw aborted();
        throw new RateLimiterUnavailableError();
      }
      denials += 1;
      onDenied?.(1);
      const now = this.now();
      const remainder = now % this.intervalMs;
      const delay = remainder === 0 ? this.intervalMs : this.intervalMs - remainder;
      waitedMs += delay;
      await this.sleep(delay, signal);
    }
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(aborted());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function aborted(): Error {
  const error = new Error('Level 2 rate wait was cancelled.');
  error.name = 'AbortError';
  return error;
}

/** Redis SET NX PX is the single cross-replica authority for Webull's app-key slot. */
@Injectable()
export class RedisRateLease implements DistributedRateLease, OnModuleDestroy {
  private readonly client: ReturnType<typeof createClient> | null;
  private readonly operationTimeoutMs: number;
  private readonly logger = new Logger(RedisRateLease.name);
  private connectPromise: Promise<void> | null = null;

  constructor(config: ConfigService) {
    const url = config.get<string>('redis.url')?.trim() ?? '';
    this.operationTimeoutMs = Math.max(
      100,
      Math.trunc(config.get<number>('redis.operationTimeoutMs') ?? 2_000),
    );
    this.client =
      url === ''
        ? null
        : createClient({
            url,
            socket: {
              connectTimeout: this.operationTimeoutMs,
              // No socketTimeout: this is a long-lived, persistent connection
              // that sits idle between acquire() calls (callers can wait up
              // to intervalMs, ~1s by default, between retries) — a socket
              // idle timeout close to that gap tore the connection down
              // mid-wait under any CI scheduling jitter, and reconnectStrategy:
              // false meant it never came back, failing the next command with
              // RateLimiterUnavailableError. Each command is already bounded
              // by operationTimeoutMs at the application level (boundedOperation
              // below), so a socket-level timeout here is redundant at best
              // and actively wrong for a connection that's expected to idle.
              reconnectStrategy: false,
            },
          });
    this.client?.on('error', (error) => {
      this.logger.warn(
        JSON.stringify({
          event: 'l2_redis_error',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }

  async tryAcquire(key: string, ttlMs: number, signal?: AbortSignal): Promise<boolean> {
    if (!this.client) throw new Error('REDIS_URL is required for the Level 2 rate limiter.');
    await this.ensureConnected(signal);
    const commandController = new AbortController();
    const result = await boundedOperation(
      this.client
        .withAbortSignal(commandController.signal)
        .set(key, randomUUID(), { NX: true, PX: ttlMs }),
      this.operationTimeoutMs,
      signal,
      (reason) => commandController.abort(reason),
    );
    return result === 'OK';
  }

  onModuleDestroy(): void {
    this.destroyClient();
  }

  private async ensureConnected(signal?: AbortSignal): Promise<void> {
    if (!this.client) throw new Error('REDIS_URL is required for the Level 2 rate limiter.');
    if (this.client.isReady) return;
    if (!this.connectPromise) {
      this.connectPromise = this.client
        .connect()
        .then(() => undefined)
        .finally(() => {
          this.connectPromise = null;
        });
    }
    await boundedOperation(this.connectPromise, this.operationTimeoutMs, signal, () =>
      this.destroyClient(),
    );
  }

  private destroyClient(): void {
    if (!this.client) return;
    try {
      this.client.destroy();
    } catch {
      // An already-closed client has no remaining socket or command work to release.
    }
  }
}

function boundedOperation<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
  onCancel?: (reason: Error) => void,
): Promise<T> {
  if (signal?.aborted) {
    const reason = aborted();
    onCancel?.(reason);
    return Promise.reject(reason);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      action();
    };
    const cancel = (reason: Error) =>
      finish(() => {
        onCancel?.(reason);
        reject(reason);
      });
    const onAbort = () => cancel(aborted());
    const timer = setTimeout(() => cancel(timedOut()), timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function timedOut(): Error {
  const error = new Error('Level 2 Redis operation timed out.');
  error.name = 'TimeoutError';
  return error;
}
