import type { AuthTokens } from '@0dtetrader/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from './SessionStore';

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

const TOKENS: AuthTokens = { accessToken: 'access-a', refreshToken: 'refresh-a' } as AuthTokens;

beforeEach(() => {
  vi.stubGlobal('localStorage', makeStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SessionStore refresh token scoping', () => {
  it('never sends one server’s refresh token to another after a server switch', async () => {
    new SessionStore('http://server-a.test:3000').signIn(TOKENS);

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const storeB = new SessionStore('https://server-b.test');

    expect(storeB.hasStoredRefreshToken()).toBe(false);
    expect(await storeB.restoreSession()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not share a token between http and https on the same host', () => {
    new SessionStore('https://server-a.test').signIn(TOKENS);
    expect(new SessionStore('http://server-a.test').hasStoredRefreshToken()).toBe(false);
  });

  it('still restores a session for the same server host', () => {
    new SessionStore('http://server-a.test:3000').signIn(TOKENS);
    expect(new SessionStore('http://server-a.test:3000').hasStoredRefreshToken()).toBe(true);
  });

  it('signing out of one server leaves another server’s token intact', async () => {
    new SessionStore('http://server-a.test:3000').signIn(TOKENS);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    const storeB = new SessionStore('https://server-b.test');
    storeB.signIn({ accessToken: 'access-b', refreshToken: 'refresh-b' } as AuthTokens);
    await storeB.signOut();

    expect(storeB.hasStoredRefreshToken()).toBe(false);
    expect(new SessionStore('http://server-a.test:3000').hasStoredRefreshToken()).toBe(true);
  });
});
