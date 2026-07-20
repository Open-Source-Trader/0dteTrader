import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from './ApiClient';
import type { SessionStore } from './SessionStore';
import { makeOptionsAnalyticsSnapshot } from '../../features/chart/optionsAnalytics/optionsAnalyticsTestFixture';

interface OptionsAnalyticsApi {
  optionsAnalytics(symbol: string, expiration: string, signal?: AbortSignal): Promise<unknown>;
}

function makeClient(): OptionsAnalyticsApi {
  const sessionStore = {
    currentAccessToken: () => 'access-token',
  } as unknown as SessionStore;
  return new ApiClient('https://api.example.test', sessionStore) as unknown as OptionsAnalyticsApi;
}

describe('ApiClient.optionsAnalytics', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests the exact options analytics path and expiration', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(makeOptionsAnalyticsSnapshot()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await makeClient().optionsAnalytics('SPY', '2026-07-19');

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      'https://api.example.test/v1/market/options-analytics?symbol=SPY&expiration=2026-07-19',
    );
    expect(init.headers).toMatchObject({ Authorization: 'Bearer access-token' });
  });

  it('rejects a malformed server snapshot at the API boundary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...makeOptionsAnalyticsSnapshot(),
            scope: { ...makeOptionsAnalyticsSnapshot().scope, spot: null },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await expect(makeClient().optionsAnalytics('SPY', '2026-07-19')).rejects.toThrow(
      /Invalid options analytics snapshot/,
    );
  });

  it('passes caller cancellation through without converting the abort into an API error', async () => {
    const fetchMock = vi.fn((_url: URL, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const request = makeClient().optionsAnalytics('SPY', '2026-07-19', controller.signal);
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
  });
});
