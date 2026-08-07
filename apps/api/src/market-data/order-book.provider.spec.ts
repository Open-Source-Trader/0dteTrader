import { OrderBookStatus } from '@0dtetrader/shared-types';
import { WebullClient } from '../broker/webull/webull-client';
import {
  WebullClientOrderBookTransport,
  WebullOrderBookProvider,
  WebullOrderBookTransport,
} from './order-book.provider';

describe('WebullOrderBookProvider', () => {
  const now = new Date('2026-08-05T14:30:00.500Z');

  it('maps and caps a documented depth payload without inventing levels', async () => {
    const requestDepth = jest.fn(async () => ({
      symbol: 'SPY',
      timestamp: 1785940200000,
      bids: [
        { price: '100.10', quantity: '12' },
        { price: '100.00', quantity: '8' },
        { price: '99.90', quantity: '5' },
      ],
      asks: [
        { price: '100.20', quantity: '10' },
        { price: '100.30', quantity: '7' },
        { price: '100.40', quantity: '4' },
      ],
    }));
    const provider = new WebullOrderBookProvider(
      { requestDepth } as WebullOrderBookTransport,
      {
        enabled: true,
        capabilityProven: true,
        maxDepth: 2,
        now: () => now,
        monotonicNow: (() => {
          let value = 10;
          return () => (value += 2);
        })(),
      } as never,
    );

    const result = await provider.fetch('spy', 50);
    expect(requestDepth).toHaveBeenCalledWith('SPY', 2);
    expect(result).toEqual({
      availability: 'available',
      decoderTimeMs: 2,
      snapshot: {
        symbol: 'SPY',
        provider: 'webull',
        capability: 'nasdaq_totalview_non_display',
        freshness: 'fresh',
        timestamp: '2026-08-05T14:30:00.000Z',
        receivedAt: '2026-08-05T14:30:00.500Z',
        depth: 2,
        bids: [
          { price: 100.1, size: 12 },
          { price: 100, size: 8 },
        ],
        asks: [
          { price: 100.2, size: 10 },
          { price: 100.3, size: 7 },
        ],
      },
    });
  });

  it.each([
    [{ enabled: false, capabilityProven: false }, 'provider_unconfigured'],
    [{ enabled: true, capabilityProven: false }, 'entitlement_missing'],
  ] as const)(
    'fails closed before calling Webull when disabled or unproven',
    async (flags, reason) => {
      const requestDepth = jest.fn();
      const provider = new WebullOrderBookProvider({ requestDepth } as WebullOrderBookTransport, {
        ...flags,
        maxDepth: 10,
        now: () => now,
      });
      const result = await provider.fetch('SPY', 5);
      expect(requestDepth).not.toHaveBeenCalled();
      expect(result.availability).toBe('unavailable');
      expect((result as { status: OrderBookStatus }).status).toMatchObject({ reason });
    },
  );

  it('rejects unsupported instruments and invalid provider books explicitly', async () => {
    const requestDepth = jest.fn(async () => ({
      timestamp: 1785940200000,
      bids: [{ price: '101', quantity: '1' }],
      asks: [{ price: '100', quantity: '1' }],
    }));
    const provider = new WebullOrderBookProvider({ requestDepth } as WebullOrderBookTransport, {
      enabled: true,
      capabilityProven: true,
      maxDepth: 10,
      now: () => now,
    });
    await expect(provider.fetch('SPX', 5)).resolves.toMatchObject({
      availability: 'unavailable',
      status: { reason: 'unsupported_instrument', retryable: false },
    });
    await expect(provider.fetch('SPY', 5)).resolves.toMatchObject({
      availability: 'unavailable',
      status: { reason: 'invalid_book', retryable: true },
    });
  });

  it('rejects a mismatched symbol and a provider timestamp that is already stale', async () => {
    const provider = new WebullOrderBookProvider(
      {
        requestDepth: jest
          .fn()
          .mockResolvedValueOnce({
            symbol: 'QQQ',
            timestamp: now.getTime(),
            bids: [{ price: 100, quantity: 1 }],
            asks: [{ price: 101, quantity: 1 }],
          })
          .mockResolvedValueOnce({
            symbol: 'SPY',
            timestamp: now.getTime() - 5_000,
            bids: [{ price: 100, quantity: 1 }],
            asks: [{ price: 101, quantity: 1 }],
          }),
      },
      { enabled: true, capabilityProven: true, maxDepth: 10, now: () => now },
    );

    await expect(provider.fetch('SPY', 5)).resolves.toMatchObject({
      availability: 'unavailable',
      status: { reason: 'invalid_book' },
    });
    await expect(provider.fetch('SPY', 5)).resolves.toMatchObject({
      availability: 'unavailable',
      status: { reason: 'stale', freshness: 'stale' },
    });
  });

  it('sorts and deduplicates provider levels before applying the published depth cap', async () => {
    const provider = new WebullOrderBookProvider(
      {
        requestDepth: jest.fn(async () => ({
          symbol: 'SPY',
          timestamp: now.getTime(),
          bids: [
            { price: 99, quantity: 2 },
            { price: 100, quantity: 3 },
            { price: 100, quantity: 4 },
          ],
          asks: [
            { price: 102, quantity: 5 },
            { price: 101, quantity: 6 },
            { price: 101, quantity: 1 },
          ],
        })),
      },
      { enabled: true, capabilityProven: true, maxDepth: 2, now: () => now },
    );

    await expect(provider.fetch('SPY', 2)).resolves.toMatchObject({
      availability: 'available',
      snapshot: {
        depth: 2,
        bids: [
          { price: 100, size: 7 },
          { price: 99, size: 2 },
        ],
        asks: [
          { price: 101, size: 7 },
          { price: 102, size: 5 },
        ],
      },
    });
  });

  it('maps 403, authentication, timeout, and provider failures to truthful statuses', async () => {
    for (const [error, reason, retryable] of [
      [Object.assign(new Error('forbidden'), { status: 403 }), 'entitlement_missing', false],
      [Object.assign(new Error('unauthorized'), { status: 401 }), 'invalid_credentials', false],
      [Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), 'request_timeout', true],
      [new Error('upstream exploded'), 'provider_error', true],
    ] as const) {
      const provider = new WebullOrderBookProvider(
        { requestDepth: jest.fn(async () => Promise.reject(error)) },
        { enabled: true, capabilityProven: true, maxDepth: 10, now: () => now },
      );
      await expect(provider.fetch('SPY', 5)).resolves.toMatchObject({
        availability: 'unavailable',
        status: { reason, retryable },
      });
    }
  });

  it('maps a timeout through the real Webull client and transport to request_timeout', async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      if (url.includes('/openapi/auth/token/create')) {
        return {
          status: 200,
          json: async () => ({ token: 'token', expires: 4_000_000_000, status: 'NORMAL' }),
        };
      }
      throw Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' });
    });
    const client = new WebullClient(
      { appKey: 'key', appSecret: 'secret' },
      {
        hosts: { api: 'https://api.example', data: 'https://data.example' },
        fetchImpl: fetchImpl as never,
      },
    );
    const provider = new WebullOrderBookProvider(new WebullClientOrderBookTransport(client), {
      enabled: true,
      capabilityProven: true,
      maxDepth: 10,
      now: () => now,
    });

    await expect(provider.fetch('SPY', 5)).resolves.toMatchObject({
      availability: 'unavailable',
      status: { reason: 'request_timeout', retryable: true },
    });
  });

  it('maps the built-in Webull HTTP timeout to request_timeout end to end', async () => {
    jest.useFakeTimers();
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).includes('/openapi/auth/token/create')) {
        return {
          status: 200,
          headers: new Headers(),
          json: async () => ({ token: 'token', expires: 4_000_000_000, status: 'NORMAL' }),
        } as Response;
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true },
        );
      });
    });
    try {
      const client = new WebullClient(
        { appKey: 'key', appSecret: 'secret' },
        { hosts: { api: 'https://api.example', data: 'https://data.example' } },
      );
      const provider = new WebullOrderBookProvider(new WebullClientOrderBookTransport(client), {
        enabled: true,
        capabilityProven: true,
        maxDepth: 10,
        now: () => now,
      });

      const result = provider.fetch('SPY', 5);
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
      await jest.advanceTimersByTimeAsync(15_000);

      await expect(result).resolves.toMatchObject({
        availability: 'unavailable',
        status: { reason: 'request_timeout', retryable: true },
      });
    } finally {
      fetchSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('keeps the built-in timeout active while the response body is being decoded', async () => {
    jest.useFakeTimers();
    let bodyRead = false;
    let outcome: Awaited<ReturnType<WebullOrderBookProvider['fetch']>> | undefined;
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).includes('/openapi/auth/token/create')) {
        return {
          status: 200,
          headers: new Headers(),
          json: async () => ({ token: 'token', expires: 4_000_000_000, status: 'NORMAL' }),
        } as Response;
      }
      return {
        status: 200,
        headers: new Headers(),
        json: () => {
          bodyRead = true;
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              { once: true },
            );
          });
        },
      } as Response;
    });
    try {
      const client = new WebullClient(
        { appKey: 'key', appSecret: 'secret' },
        { hosts: { api: 'https://api.example', data: 'https://data.example' } },
      );
      const provider = new WebullOrderBookProvider(new WebullClientOrderBookTransport(client), {
        enabled: true,
        capabilityProven: true,
        maxDepth: 10,
        now: () => now,
      });

      void provider.fetch('SPY', 5).then((result) => {
        outcome = result;
      });
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      expect(bodyRead).toBe(true);
      await jest.advanceTimersByTimeAsync(15_000);
      await Promise.resolve();

      expect(outcome).toMatchObject({
        availability: 'unavailable',
        status: { reason: 'request_timeout', retryable: true },
      });
    } finally {
      fetchSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('propagates an external abort received after response headers through the real transport', async () => {
    let bodyRead = false;
    let outcome: Awaited<ReturnType<WebullOrderBookProvider['fetch']>> | undefined;
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).includes('/openapi/auth/token/create')) {
        return {
          status: 200,
          headers: new Headers(),
          json: async () => ({ token: 'token', expires: 4_000_000_000, status: 'NORMAL' }),
        } as Response;
      }
      return {
        status: 200,
        headers: new Headers(),
        json: () => {
          bodyRead = true;
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              { once: true },
            );
          });
        },
      } as Response;
    });
    try {
      const client = new WebullClient(
        { appKey: 'key', appSecret: 'secret' },
        { hosts: { api: 'https://api.example', data: 'https://data.example' } },
      );
      const provider = new WebullOrderBookProvider(new WebullClientOrderBookTransport(client), {
        enabled: true,
        capabilityProven: true,
        maxDepth: 10,
        now: () => now,
      });
      const controller = new AbortController();

      void provider.fetch('SPY', 5, controller.signal).then((result) => {
        outcome = result;
      });
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      expect(bodyRead).toBe(true);
      controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(outcome).toMatchObject({
        availability: 'unavailable',
        status: { reason: 'request_timeout', retryable: true },
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('passes an external cancellation signal through the client request', async () => {
    let businessSignal: AbortSignal | undefined;
    const fetchImpl = jest.fn(async (url: string, init: { signal?: AbortSignal }) => {
      if (url.includes('/openapi/auth/token/create')) {
        return {
          status: 200,
          json: async () => ({ token: 'token', expires: 4_000_000_000, status: 'NORMAL' }),
        };
      }
      businessSignal = init.signal;
      return { status: 200, json: async () => ({ ok: true }) };
    });
    const client = new WebullClient(
      { appKey: 'key', appSecret: 'secret' },
      {
        hosts: { api: 'https://api.example', data: 'https://data.example' },
        fetchImpl: fetchImpl as never,
      },
    );
    const signal = new AbortController().signal;

    await (
      client.request as unknown as (
        endpoint: 'stockDepth',
        options: { signal: AbortSignal },
      ) => Promise<unknown>
    )('stockDepth', { signal });

    expect(businessSignal).toBe(signal);
  });
});

describe('WebullClientOrderBookTransport', () => {
  it('uses the documented query and disables retries outside the distributed grant', async () => {
    const request = jest.fn(async () => ({ ok: true }));
    const transport = new WebullClientOrderBookTransport({ request } as never);
    await expect(transport.requestDepth('SPY', 10)).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith('stockDepth', {
      query: {
        symbol: 'SPY',
        category: 'US_STOCK',
        depth: '10',
        overnight_required: 'false',
      },
      automaticRetries: false,
    });
  });
});
