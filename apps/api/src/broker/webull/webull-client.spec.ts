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
    const { client, calls } = makeHarness(withToken(() => ({ status: 200, body: { ok: true } })));
    const result = await client.request('accountList');
    expect(result).toEqual({ ok: true });

    expect(calls[0].url).toBe('https://api.sandbox.webull.com/openapi/auth/token/create');
    expect(calls[1].url).toBe('https://api.sandbox.webull.com/openapi/account/list');
    const headers = calls[1].init.headers as Record<string, string>;
    expect(headers['x-app-key']).toBe('key');
    expect(headers['x-signature']).toBeDefined();
    expect(headers['x-access-token']).toBe('tok-1');
    expect(headers['x-version']).toBe('v2');
    expect(JSON.stringify(headers)).not.toContain('secret');
  });

  it('caches the token across requests (one create for many calls)', async () => {
    const { client, calls } = makeHarness(withToken(() => ({ status: 200, body: [] })));
    await client.request('accountList');
    await client.request('balance', { query: { account_id: 'ACC-1' } });
    await client.request('positions', { query: { account_id: 'ACC-1' } });
    const tokenCalls = calls.filter((c) => c.url.includes('/openapi/auth/token/'));
    expect(tokenCalls).toHaveLength(1);
    expect(calls).toHaveLength(4);
  });

  it('reauthenticate() discards the token and forces a fresh create', async () => {
    const { client, calls } = makeHarness(withToken(() => ({ status: 200, body: { ok: true } })));
    await client.request('accountList');
    await client.reauthenticate();
    await client.request('accountList');
    const creates = calls.filter((c) => c.url.includes('/openapi/auth/token/create'));
    expect(creates).toHaveLength(2);
    expect(calls.filter((c) => c.url.includes('/openapi/auth/token/refresh'))).toHaveLength(0);
  });

  it('latches after an auth-class token failure — never auto-recreates', async () => {
    let nowMs = 1_000_000;
    const calls: { url: string }[] = [];
    const fetchImpl: FetchImpl = async (url) => {
      calls.push({ url });
      if (url.includes('/openapi/auth/token/create')) {
        // e.g. 417 2FA_VERIFY_FAILED while a verification is outstanding
        return { status: 417, json: async () => ({ code: 'X', message: 'fail' }) };
      }
      return { status: 200, json: async () => ({ ok: true }) };
    };
    const client = new WebullClient(CREDS, {
      hosts: HOSTS,
      fetchImpl,
      sleep: async () => {},
      now: () => new Date(nowMs),
    });
    const creates = () => calls.filter((c) => c.url.includes('/openapi/auth/token/create'));

    // First failure hits the endpoint once; every later call fails fast
    // locally with the same auth error — no more creates, even after the
    // old backoff window would have expired.
    await expect(client.request('accountList')).rejects.toMatchObject({
      code: 'BROKER_AUTH_FAILED',
    });
    await expect(client.request('accountList')).rejects.toMatchObject({
      code: 'BROKER_AUTH_FAILED',
    });
    expect(creates()).toHaveLength(1);
    nowMs += 61_000;
    await expect(client.request('accountList')).rejects.toMatchObject({
      code: 'BROKER_AUTH_FAILED',
    });
    expect(creates()).toHaveLength(1);
  });

  it('backs off TRANSIENT token-creation failures, then retries once', async () => {
    let nowMs = 1_000_000;
    let createAttempts = 0;
    const calls: { url: string }[] = [];
    const fetchImpl: FetchImpl = async (url) => {
      calls.push({ url });
      if (url.includes('/openapi/auth/token/create')) {
        createAttempts += 1;
        if (createAttempts === 1) throw new TypeError('fetch failed');
        return { status: 200, json: async () => TOKEN_BODY };
      }
      return { status: 200, json: async () => ({ ok: true }) };
    };
    const client = new WebullClient(CREDS, {
      hosts: HOSTS,
      fetchImpl,
      sleep: async () => {},
      now: () => new Date(nowMs),
    });

    await expect(client.request('accountList')).rejects.toMatchObject({
      code: 'BROKER_UNAVAILABLE',
    });
    // Inside the backoff window: fails fast without touching the endpoint.
    await expect(client.request('accountList')).rejects.toMatchObject({
      code: 'BROKER_RATE_LIMITED',
    });
    expect(createAttempts).toBe(1);
    // After the window: exactly one real retry, which succeeds.
    nowMs += 3_000;
    await expect(client.request('accountList')).resolves.toEqual({ ok: true });
    expect(createAttempts).toBe(2);
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

  it('accepts a pending-verification token (verified live: PENDING tokens serve calls)', async () => {
    const { client, calls } = makeHarness((url) => {
      if (url.includes('/openapi/auth/token/create')) {
        return {
          status: 200,
          body: { token: 'tok-p', expires: 9999999999, status: 'PENDING' },
        };
      }
      return { status: 200, body: { ok: 1 } };
    });
    await expect(client.request('accountList')).resolves.toEqual({ ok: 1 });
    const lastBusiness = calls[calls.length - 1];
    expect(lastBusiness.init.headers['x-access-token']).toBe('tok-p');
  });

  it('maps a non-normal, non-pending token to BROKER_AUTH_FAILED with guidance', async () => {
    const { client } = makeHarness(() => ({
      status: 200,
      body: { token: 'tok-s', expires: 9999999999, status: 'SUSPENDED' },
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

  it('latches after a business-call 401 — no auto re-create; reauthenticate() recovers', async () => {
    let businessCalls = 0;
    const { client, calls } = makeHarness((url) => {
      if (url.includes('/openapi/auth/token/create')) {
        return { status: 200, body: TOKEN_BODY };
      }
      businessCalls += 1;
      return businessCalls <= 2
        ? { status: 401, body: { code: 'UNAUTHORIZED' } }
        : { status: 200, body: { ok: 1 } };
    });
    await expect(client.request('accountList')).rejects.toMatchObject({
      code: 'BROKER_AUTH_FAILED',
      httpStatus: 401,
    });
    // Latched: the next call fails fast without a new token create.
    await expect(client.request('accountList')).rejects.toMatchObject({
      code: 'BROKER_AUTH_FAILED',
    });
    expect(calls.filter((c) => c.url.includes('/openapi/auth/token/create'))).toHaveLength(1);

    // The Reconnect button is the only path to a fresh token.
    await client.reauthenticate();
    await expect(client.request('accountList')).resolves.toEqual({ ok: 1 });
    expect(calls.filter((c) => c.url.includes('/openapi/auth/token/create'))).toHaveLength(2);
  });

  it('serves calls with a PENDING token and promotes it via token/check', async () => {
    let nowMs = 1_000_000;
    const calls: { url: string; init: { headers: Record<string, string> } }[] = [];
    const fetchImpl: FetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url.includes('/openapi/auth/token/create')) {
        return {
          status: 200,
          json: async () => ({ token: 'tok-p', expires: 9999999999, status: 'PENDING' }),
        };
      }
      if (url.includes('/openapi/auth/token/check')) {
        return { status: 200, json: async () => ({ status: 'NORMAL' }) };
      }
      return { status: 200, json: async () => ({ ok: 1 }) };
    };
    const client = new WebullClient(CREDS, {
      hosts: HOSTS,
      fetchImpl,
      sleep: async () => {},
      now: () => new Date(nowMs),
    });

    // First call: create (PENDING) + optimistic business call with tok-p.
    await expect(client.request('accountList')).resolves.toEqual({ ok: 1 });
    expect(calls[calls.length - 1].init.headers['x-access-token']).toBe('tok-p');

    // The next call polls token/check once, learns NORMAL, keeps the token.
    nowMs += 21_000;
    await expect(client.request('accountList')).resolves.toEqual({ ok: 1 });
    const creates = calls.filter((c) => c.url.includes('/openapi/auth/token/create'));
    const checks = calls.filter((c) => c.url.includes('/openapi/auth/token/check'));
    expect(creates).toHaveLength(1);
    expect(checks).toHaveLength(1);

    // Now NORMAL: no further creates or checks.
    nowMs += 21_000;
    await expect(client.request('accountList')).resolves.toEqual({ ok: 1 });
    expect(calls.filter((c) => c.url.includes('/openapi/auth/token/'))).toHaveLength(2);
  });

  it('latches when a PENDING token expires unverified (5-minute window)', async () => {
    const { client, calls } = makeHarness((url) => {
      if (url.includes('/openapi/auth/token/create')) {
        return {
          status: 200,
          body: { token: 'tok-x', expires: 9999999999, status: 'PENDING' },
        };
      }
      if (url.includes('/openapi/auth/token/check')) {
        return { status: 200, body: { status: 'EXPIRED' } };
      }
      return { status: 200, body: { ok: 1 } };
    });
    // First call goes through with the PENDING token attached.
    await expect(client.request('accountList')).resolves.toEqual({ ok: 1 });
    // The status poll then learns EXPIRED: latch with Reconnect guidance.
    await expect(client.request('accountList')).rejects.toMatchObject({
      code: 'BROKER_AUTH_FAILED',
    });
    // Latched: fails fast, no HTTP at all on subsequent calls.
    const count = calls.length;
    await expect(client.request('accountList')).rejects.toMatchObject({
      code: 'BROKER_AUTH_FAILED',
    });
    expect(calls).toHaveLength(count);
    expect(calls.filter((c) => c.url.includes('/openapi/auth/token/create'))).toHaveLength(1);
  });

  it('maps quote-subscription 401s to BROKER_PERMISSION_DENIED and keeps the token', async () => {
    const { client, calls } = makeHarness(
      withToken(() => ({
        status: 401,
        body: {
          error_code: 'Unauthorized',
          message: 'Insufficient permission, please subscribe to stock quotes.',
        },
      })),
    );
    await expect(client.request('stockBars')).rejects.toMatchObject({
      code: 'BROKER_PERMISSION_DENIED',
      httpStatus: 403,
    });
    // Token must NOT be cleared: no second token/create on the next call.
    await expect(client.request('stockBars')).rejects.toMatchObject({
      code: 'BROKER_PERMISSION_DENIED',
    });
    const tokenCalls = calls.filter((c) => c.url.includes('/openapi/auth/token/create'));
    expect(tokenCalls).toHaveLength(1);
  });
});

describe('WebullClient resilience', () => {
  it('retries 429 honoring Retry-After and then succeeds', async () => {
    const { client, calls, sleeps } = makeHarness(
      withToken(
        (() => {
          let n = 0;
          return () => {
            n += 1;
            return n <= 2
              ? { status: 429, headers: { 'retry-after': '0' } }
              : { status: 200, body: { ok: 1 } };
          };
        })(),
      ),
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
      withToken(
        (() => {
          let n = 0;
          return () => {
            n += 1;
            return n <= 2 ? { status: 429 } : { status: 200, body: { ok: 1 } };
          };
        })(),
      ),
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
      withToken(
        (() => {
          let n = 0;
          return () => {
            n += 1;
            return n === 1 ? { status: 500 } : { status: 200, body: { ok: true } };
          };
        })(),
      ),
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
    const { client, calls } = makeHarness(withToken(() => ({ status: 200, body: {} })));
    await client.request('orderCancel', {
      body: { a: 1, b: 'two' } as never,
    });
    const cancel = calls.find((c) => c.url.includes('/cancel'))!;
    expect(cancel.init.body).toBe('{"a":1,"b":"two"}');
  });
});

describe('WebullClient error mapping (docs/WEBULL-INTEGRATION.md §6)', () => {
  // Buying-power / order-rejected mappings only apply to /trade/ endpoints;
  // the same body on a non-trade endpoint is a parameter problem and must
  // fall through to BROKER_ERROR (last case pins that).
  const cases: ['accountList' | 'orderPlace', number, unknown, string, number][] = [
    [
      'orderPlace',
      417,
      { code: 'INSUFFICIENT_BUYING_POWER', message: 'not enough buying power' },
      'INSUFFICIENT_BUYING_POWER',
      400,
    ],
    ['accountList', 417, { code: 'OPENAPI_NO_NIGHT_TRADING_TIME' }, 'MARKET_CLOSED', 400],
    ['orderPlace', 417, { code: 'SOME_REJECT', message: 'bad order' }, 'ORDER_REJECTED', 400],
    ['orderPlace', 400, { message: 'insufficient buying power' }, 'INSUFFICIENT_BUYING_POWER', 400],
    ['accountList', 401, { code: 'UNAUTHORIZED' }, 'BROKER_AUTH_FAILED', 401],
    ['accountList', 429, {}, 'BROKER_RATE_LIMITED', 503],
    [
      'accountList',
      417,
      { code: 'INSUFFICIENT_BUYING_POWER', message: 'not enough buying power' },
      'BROKER_ERROR',
      400,
    ],
  ];

  it.each(cases)(
    'maps %s %i %j → %s (%i)',
    async (endpoint, status, body, expectedCode, expectedHttp) => {
      const { client } = makeHarness(
        withToken(() => ({ status, body, headers: { 'retry-after': '0' } })),
      );
      await expect(client.request(endpoint)).rejects.toMatchObject({
        code: expectedCode,
        httpStatus: expectedHttp,
      });
    },
  );
});

describe('token persistence (tokenStore)', () => {
  interface StoredShape {
    token: string;
    expiresAt: number;
    status: string;
  }

  function makeStore(initial: StoredShape | null = null) {
    let value: StoredShape | null = initial;
    return {
      load: jest.fn(async () => value),
      save: jest.fn(async (token: StoredShape) => {
        value = token;
      }),
      clear: jest.fn(async () => {
        value = null;
      }),
      get value() {
        return value;
      },
    };
  }

  function makeClientWith(
    store: ReturnType<typeof makeStore>,
    responses: (url: string) => FakeResponse,
  ) {
    const calls: { url: string }[] = [];
    const fetchImpl: FetchImpl = async (url, _init) => {
      calls.push({ url });
      const res = responses(url);
      return {
        status: res.status,
        headers: { get: () => null },
        json: async () => res.body,
      };
    };
    const client = new WebullClient(
      { ...CREDS },
      { hosts: HOSTS, fetchImpl, tokenStore: store, sleep: async () => {} },
    );
    return { client, calls };
  }

  it('restores a persisted NORMAL token instead of creating a new one', async () => {
    const store = makeStore({
      token: 'tok-restored',
      expiresAt: Date.now() + 14 * 86_400_000,
      status: 'NORMAL',
    });
    const { client, calls } = makeClientWith(store, (url) => {
      if (url.includes('/auth/token/')) {
        throw new Error('no token endpoint should be touched');
      }
      return { status: 200, body: [] };
    });
    await client.request('accountList');
    expect(calls.some((c) => c.url.includes('/auth/token/'))).toBe(false);
    expect(store.load).toHaveBeenCalledTimes(1);
  });

  it('persists a newly created token', async () => {
    const store = makeStore(null);
    const { client } = makeClientWith(store, (url) => {
      if (url.includes('/auth/token/create')) {
        return { status: 200, body: TOKEN_BODY };
      }
      return { status: 200, body: [] };
    });
    await client.request('accountList');
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.value?.token).toBe('tok-1');
    expect(store.value?.status).toBe('NORMAL');
  });

  it('refreshes (not creates) a persisted token close to expiry and saves the result', async () => {
    const store = makeStore({
      token: 'tok-old',
      expiresAt: Date.now() + 86_400_000, // 1d left, inside the 2d margin
      status: 'NORMAL',
    });
    const { client, calls } = makeClientWith(store, (url) => {
      if (url.includes('/auth/token/refresh')) {
        return { status: 200, body: { ...TOKEN_BODY, token: 'tok-refreshed' } };
      }
      if (url.includes('/auth/token/create')) {
        throw new Error('must refresh, not create');
      }
      return { status: 200, body: [] };
    });
    await client.request('accountList');
    expect(calls.some((c) => c.url.includes('/auth/token/refresh'))).toBe(true);
    expect(store.value?.token).toBe('tok-refreshed');
  });

  it('clears the store on reauthenticate before minting a fresh token', async () => {
    const store = makeStore({
      token: 'tok-stale',
      expiresAt: Date.now() + 14 * 86_400_000,
      status: 'NORMAL',
    });
    const { client } = makeClientWith(store, (url) => {
      if (url.includes('/auth/token/create')) {
        return { status: 200, body: TOKEN_BODY };
      }
      return { status: 200, body: [] };
    });
    await client.reauthenticate();
    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(store.value?.token).toBe('tok-1');
  });
});
