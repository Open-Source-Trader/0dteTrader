import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { AppKeyRateLimiter, RedisRateLease } from './order-book-rate-limiter';

const redisUrl = process.env.REDIS_URL?.trim();
const describeRedis = redisUrl ? describe : describe.skip;

describeRedis('AppKeyRateLimiter real Redis integration', () => {
  it('serializes grants from independent lease clients using one shared app-key authority', async () => {
    const config = {
      get: jest.fn((key: string) => (key === 'redis.url' ? redisUrl : undefined)),
    } as unknown as ConfigService;
    const firstLease = new RedisRateLease(config);
    const secondLease = new RedisRateLease(config);
    const first = new AppKeyRateLimiter(firstLease);
    const second = new AppKeyRateLimiter(secondLease);
    const appKey = `integration-${randomUUID()}`;
    const startedAt = Date.now();

    try {
      const waits = await Promise.all([first.acquire(appKey), second.acquire(appKey)]);
      expect(waits.filter((value) => value.waitedMs === 0)).toHaveLength(1);
      expect(Math.max(...waits.map((value) => value.waitedMs))).toBeGreaterThanOrEqual(1_000);
      expect(waits.reduce((sum, value) => sum + value.denials, 0)).toBeGreaterThanOrEqual(1);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    } finally {
      await Promise.all([firstLease.onModuleDestroy(), secondLease.onModuleDestroy()]);
    }
  }, 10_000);
});
