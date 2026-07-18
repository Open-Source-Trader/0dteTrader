import { FetchImpl, WebullClient } from './webull-client';

/**
 * HTTP-layer tests for WebullClient: token create/cache/refresh, request
 * signing wiring, 429 backoff, 5xx retry, and error mapping. The signature
 * recipe itself is covered by the official docs vector in
 * webull-signer.spec.ts.
 */

const CREDS = { appKey: 'key', appSecret: 'secret', accountId: 'ACC-1' };
const HOSTS = {
  api: 'https://api.sandbox.webull.com',
  data: 'https://data-api.sandbox.webull.com',
};

interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

function makeHarness(responses: FakeResponse[] | ((url: string) => FakeResponse)) {
  const calls: { url: string; init: any }[] = [];
  const queue = [...(Array.isArray(responses) ? responses : [])];
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push({ url, init });
    const res = Array.isArray(responses)
      ? (queue.shift() ?? queue[queue.length - 1] ?? { status: 200, body: {} })
      : responses(url);
    return {
      status: res.status,
      headers: {
        get: (name: string) => res.headers?.[name.toLowerCase()] ?? null,
      },
      json: async () => res.body,
    };
  };
  const sleeps: number[] = [];
  const client = new WebullClient(CREDS, {
    hosts: HOSTS,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, calls, sleeps };
}

const TOKEN_BODY = {
  token: 'tok-1',
  expires: Math.floor(Date.now() / 1000) + 15 * 86_400,
  status: 'NORMAL',
};

function withToken(handler: (url: string) => FakeResponse): (url: string) => FakeResponse {
  return (url) => {
    if (url.includes('/openapi/auth/token/create')) {
      return { status: 200, body: TOKEN_BODY };
    }
    return handler(url);
  };
}

describe('WebullClient token lifecycle', () => {
  it('creates a token on the first call and attaches x-access-token after', async () => {
    const { client, calls } = makeHarness(
      withToken(() => ({ status: 200, body: { ok: true } })),
    );
    const result = await client.request('accountList');
    expect(result).toEqual({ ok: true });

    expect(calls[0].url).toBe(
      'https://api.sandbox.webull.com/openapi/auth/token/create',
    );
    expect(calls[1].url).toBe(
      'https://api.sandbox.webull.com/openapi/account/list',
    );
    const headers = calls[1].init.headers as Record<string, string>;
    expect(headers['x-app-key']).toBe('key');
    expect(headers['x-signature']).toBeDefined();
    expect(headers['x-access-token']).toBe('tok-1');
    expect(headers['x-version']).toBe('v2');
    expect(JSON.stringify(headers)).not.toContain('secret');
  });

  it('caches the token across requests (one create for many calls)', async () => {
    const { client, calls } = makeHarness(
      withToken(() => ({ status: 200, body: [] })),
    );
    await client.request('accountList');
    await client.request('balance', { query: { account_id: 'ACC-1' } });
    await client.request('positions', { query: { account_id: 'ACC-1' } });
    const tokenCalls = calls.filter((c) =>
      c.url.includes('/openapi/auth/token/'),
    );
    expect(tokenCalls).toHaveLength(1);
    expect(calls).toHaveLength(4);
  });

  it('refreshes a token that is near expiry', async () => {
    const soonExpiring = {
      token: 'tok-old',
      expires: Math.floor(Date.now() / 1000) + 3600, // < 2-day margin
      status: 'NORMAL',
    };
    const refreshed = {
      token: 'tok-new',
      expires: Math.floor(Date.now() / 1000) + 15 * 86_400,
      status: 'NORMAL',
    };
    let tokenCalls = 0;
    const { client, calls } = makeHarness((url) => {
      if (url.includes('/openapi/auth/token/create')) {
        tokenCalls += 1;
        return { status: 200, body: soonExpiring };
      }
      if (url.includes('/openapi/auth/token/refresh')) {
        tokenCalls += 1;
        return { status: 200, body: refreshed };
      }
      return { status: 200, body: { ok: 1 } };
    });
    await client.request('accountList');
    await client.request('accountList');
    expect(tokenCalls).toBe(2); // create + refresh
    const refreshCall = calls.find((c) => c.url.includes('/refresh'))!;
    expect(JSON.parse(refreshCall.init.body)).toEqual({ token: 'tok-old' });
    const lastBusiness = calls[calls.length - 1];
    expect(lastBusiness.init.headers['x-access-token']).toBe('tok-new');
  });

  it('maps a pending-verification token to BROKER_AUTH_FAILED with guidance', async () => {
    const { client } = makeHarness(() => ({
      status: 200,
      body: { token: 'tok-p', expires: 9999999999, status: 'PENDING' },
    }));
    await expect(client.request('accountList')).rejects.toMatchObject({
      code: 'BROKER_AUTH_FAILED',
      httpStatus: 401,
    });
  });

  it('maps malformed token responses to BROKER_AUTH_FAILED', async () => {
    const { client } = makeHarness(() => ({ status: 200, body: {} }));
    await expect(client.request('accountList')).rejects.toMatchObject({
      code: 'BROKER_AUTH_FAILED',
    });
  });

  it('clears the cached token after a 401 and re-creates it next call', async () => {
    let businessCalls = 0;
    const { client, calls } = makeHarness((url) => {
      if (url.includes('/openapi/auth/token/create')) {
        return { status: 200, body: TOKEN_BODY };
      }
      businessCalls += 1;
      return businessCalls === 1
        ? { status: 401, body: { code: 'UNAUTHORIZED' } }
        : { status: 200, body: { ok: 1 } };
    });
    await expect(client.request('accountList')).rejects.toMatchObject({
      code: 'BROKER_AUTH_FAILED',
      httpStatus: 401,
    });
    await client.request('accountList');
    const tokenCalls = calls.filter((c) =>
      c.url.includes('/openapi/auth/token/create'),
    );
    expect(tokenCalls).toHaveLength(2);
  });
});

describe('WebullClient resilience', () => {
  it('retries 429 honoring Retry-After and then succeeds', async () => {
    const { client, calls, sleeps } = makeHarness(
      withToken((() => {
        let n = 0;
        return () => {
          n += 1;
          return n <= 2
            ? { status: 429, headers: { 'retry-after': '0' } }
            : { status: 200, body: { ok: 1 } };
        };
      })()),
    );
    const result = await client.request('balance', {
      query: { account_id: 'ACC-1' },
    });
    expect(result).toEqual({ ok: 1 });
    expect(calls).toHaveLength(4); // token + 429 + 429 + 200
    expect(sleeps).toEqual([0, 0]);
  });

  it('uses exponential backoff with jitter when Retry-After is absent', async () => {
    const { client, sleeps } = makeHarness(
      withToken((() => {
        let n = 0;
        return () => {
          n += 1;
          return n <= 2 ? { status: 429 } : { status: 200, body: { ok: 1 } };
        };
      })()),
    );
    await client.request('balance', { query: { account_id: 'ACC-1' } });
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(250);
    expect(sleeps[0]).toBeLessThanOrEqual(500);
    expect(sleeps[1]).toBeGreaterThanOrEqual(500);
    expect(sleeps[1]).toBeLessThanOrEqual(1000);
  });

  it('maps exhausted 429 retries to BROKER_RATE_LIMITED (503)', async () => {
    const { client, calls } = makeHarness(
      withToken(() => ({ status: 429, headers: { 'retry-after': '0' } })),
    );
    await expect(
      client.request('balance', { query: { account_id: 'ACC-1' } }),
    ).rejects.toMatchObject({ code: 'BROKER_RATE_LIMITED', httpStatus: 503 });
    expect(calls).toHaveLength(1 + 5); // token + initial + 4 retries
  });

  it('retries a 5xx once before surfacing the error', async () => {
    const { client, calls } = makeHarness(
      withToken((() => {
        let n = 0;
        return () => {
          n += 1;
          return n === 1 ? { status: 500 } : { status: 200, body: { ok: true } };
        };
      })()),
    );
    const result = await client.request('accountList');
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(3); // token + 500 + 200
  });

  it('maps network failures to BROKER_UNAVAILABLE (503)', async () => {
    const fetchImpl: FetchImpl = async (url) => {
      if (url.includes('/openapi/auth/token/create')) {
        return { status: 200, json: async () => TOKEN_BODY };
      }
      throw new TypeError('fetch failed');
    };
    const client = new WebullClient(CREDS, {
      hosts: HOSTS,
      fetchImpl,
      sleep: async () => undefined,
    });
    await expect(client.request('accountList')).rejects.toMatchObject({
      code: 'BROKER_UNAVAILABLE',
      httpStatus: 503,
    });
  });

  it('sends the exact compact-JSON bytes it signed', async () => {
    const { client, calls } = makeHarness(
      withToken(() => ({ status: 200, body: {} })),
    );
    await client.request('orderCancel', {
      body: { a: 1, b: 'two' } as never,
    });
    const cancel = calls.find((c) => c.url.includes('/cancel'))!;
    expect(cancel.init.body).toBe('{"a":1,"b":"two"}');
  });
});

describe('WebullClient error mapping (docs/WEBULL-INTEGRATION.md §6)', () => {
  const cases: [number, unknown, string, number][] = [
    [417, { code: 'INSUFFICIENT_BUYING_POWER', message: 'not enough buying power' }, 'INSUFFICIENT_BUYING_POWER', 400],
    [417, { code: 'OPENAPI_NO_NIGHT_TRADING_TIME' }, 'MARKET_CLOSED', 400],
    [417, { code: 'SOME_REJECT', message: 'bad order' }, 'ORDER_REJECTED', 400],
    [400, { message: 'insufficient buying power' }, 'INSUFFICIENT_BUYING_POWER', 400],
    [401, { code: 'UNAUTHORIZED' }, 'BROKER_AUTH_FAILED', 401],
    [429, {}, 'BROKER_RATE_LIMITED', 503],
  ];

  it.each(cases)(
    'maps %i %j → %s (%i)',
    async (status, body, expectedCode, expectedHttp) => {
      const { client } = makeHarness(
        withToken(() => ({ status, body, headers: { 'retry-after': '0' } })),
      );
      await expect(client.request('accountList')).rejects.toMatchObject({
        code: expectedCode,
        httpStatus: expectedHttp,
      });
    },
  );
});
