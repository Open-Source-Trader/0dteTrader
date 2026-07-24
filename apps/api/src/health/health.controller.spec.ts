import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';

/**
 * Railway polls this endpoint as its healthcheck target, so it must answer
 * promptly and independently of any third party. The outbound-IP lookup is
 * decoration; it must never be able to hold the response open.
 */
function stubResponse(): { res: Response; statusCode: () => number | undefined } {
  let captured: number | undefined;
  const res = { status: (code: number) => (captured = code) } as unknown as Response;
  return { res, statusCode: () => captured };
}

function controllerWith(queryRaw: () => Promise<unknown>): HealthController {
  return new HealthController({ $queryRawUnsafe: queryRaw } as unknown as PrismaService);
}

describe('HealthController', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('reports ok and the outbound IP when the database and lookup both succeed', async () => {
    global.fetch = (async () => ({
      text: async () => '203.0.113.7',
    })) as unknown as typeof fetch;
    const { res } = stubResponse();

    const result = await controllerWith(async () => [{ '?column?': 1 }]).check(res);

    expect(result.status).toBe('ok');
    expect(result.db).toBe('ok');
    expect(result.outboundIp).toBe('203.0.113.7');
  });

  it('still answers ok when the outbound-IP lookup hangs', async () => {
    // A lookup that never settles on its own: only the abort signal can end it.
    global.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const { res } = stubResponse();

    const result = await controllerWith(async () => [{ '?column?': 1 }]).check(res);

    expect(result.status).toBe('ok');
    expect(result.outboundIp).toBe('unknown');
  }, 10_000);

  it('degrades to 503 when the database is unreachable', async () => {
    global.fetch = (async () => ({
      text: async () => '203.0.113.7',
    })) as unknown as typeof fetch;
    const { res, statusCode } = stubResponse();

    const result = await controllerWith(async () => {
      throw new Error('connection refused');
    }).check(res);

    expect(result.status).toBe('degraded');
    expect(result.db).toBe('error');
    expect(statusCode()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });
});
