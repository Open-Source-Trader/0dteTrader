import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_API_BASE_URL, deriveStreamUrl } from '../../app/config';
import { SERVER_BASE_URL_KEY, ServerConfigStore, checkServerHealth } from './ServerConfigStore';

/** In-memory localStorage double (the node test env has no DOM storage). */
function makeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ServerConfigStore', () => {
  it('falls back to the build-time default when nothing is stored', () => {
    expect(new ServerConfigStore().load()).toBe(DEFAULT_API_BASE_URL);
  });

  it('persists a valid https URL and loads it back', () => {
    const store = new ServerConfigStore();
    store.save('https://my-api.up.railway.app');
    expect(store.load()).toBe('https://my-api.up.railway.app');
    expect(localStorage.getItem(SERVER_BASE_URL_KEY)).toBe('https://my-api.up.railway.app');
  });

  it('trims whitespace and strips a trailing slash', () => {
    const store = new ServerConfigStore();
    store.save('  https://my-api.up.railway.app/  ');
    expect(store.load()).toBe('https://my-api.up.railway.app');
  });

  it('strips a pasted /v1 suffix (with or without trailing slash)', () => {
    const store = new ServerConfigStore();
    store.save('https://my-api.up.railway.app/v1');
    expect(store.load()).toBe('https://my-api.up.railway.app');
    store.save('https://my-api.up.railway.app/v1/');
    expect(store.load()).toBe('https://my-api.up.railway.app');
  });

  it('rejects junk that is not a URL', () => {
    const store = new ServerConfigStore();
    expect(() => store.save('not a url')).toThrow(/http/);
    expect(store.load()).toBe(DEFAULT_API_BASE_URL);
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => new ServerConfigStore().save('ftp://my-api.up.railway.app')).toThrow(/http/);
  });

  it('ignores an invalid stored value and falls back to the default', () => {
    localStorage.setItem(SERVER_BASE_URL_KEY, 'garbage');
    expect(new ServerConfigStore().load()).toBe(DEFAULT_API_BASE_URL);
  });

  it('reset clears the override', () => {
    const store = new ServerConfigStore();
    store.save('https://my-api.up.railway.app');
    store.reset();
    expect(store.load()).toBe(DEFAULT_API_BASE_URL);
    expect(localStorage.getItem(SERVER_BASE_URL_KEY)).toBeNull();
  });

  it('notifies subscribers with the new base URL on save and reset', () => {
    const store = new ServerConfigStore();
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getState().baseUrl));
    store.save('https://my-api.up.railway.app');
    store.reset();
    expect(seen).toEqual(['https://my-api.up.railway.app', DEFAULT_API_BASE_URL]);
  });
});

describe('deriveStreamUrl', () => {
  it('derives wss for https bases', () => {
    expect(deriveStreamUrl('https://my-api.up.railway.app')).toBe(
      'wss://my-api.up.railway.app/v1/stream',
    );
  });

  it('derives ws for http bases', () => {
    expect(deriveStreamUrl('http://localhost:3000')).toBe('ws://localhost:3000/v1/stream');
  });
});

describe('checkServerHealth', () => {
  it('reports reachable when /v1/health answers ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok', db: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkServerHealth('https://my-api.up.railway.app');

    expect(result).toEqual({ ok: true, message: 'Server reachable, API ok' });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://my-api.up.railway.app/v1/health');
  });

  it('reports a degraded server (non-2xx health response)', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ status: 'degraded', db: 'error' }), { status: 503 }),
        ),
    );

    const result = await checkServerHealth('https://my-api.up.railway.app');

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/503/);
  });

  it('reports unreachable on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const result = await checkServerHealth('https://my-api.up.railway.app');

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/unreachable/i);
  });

  it('reports a timeout distinctly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('The operation timed out', 'TimeoutError')),
    );

    const result = await checkServerHealth('https://my-api.up.railway.app');

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/timed out/i);
  });

  it('rejects an invalid URL without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkServerHealth('garbage');

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
