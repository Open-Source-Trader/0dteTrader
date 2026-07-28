import { DEFAULT_API_BASE_URL } from '../../app/config';
import { Store } from '../../core/observable';

export const SERVER_BASE_URL_KEY = 'serverBaseUrl';

/** Runtime server selection: a localStorage override of the build-time API
    base URL, so self-hosters can point the app at their own backend. */
export class ServerConfigStore extends Store<{ baseUrl: string }> {
  constructor() {
    super({ baseUrl: loadStoredBaseUrl() });
  }

  /** The stored override if valid, else the build-time default. */
  load(): string {
    return loadStoredBaseUrl();
  }

  /** Normalizes, validates, and persists a new base URL. Throws on invalid input. */
  save(input: string): string {
    const baseUrl = normalizeServerUrl(input);
    localStorage.setItem(SERVER_BASE_URL_KEY, baseUrl);
    this.set({ baseUrl });
    return baseUrl;
  }

  /** Clears the override, reverting to the build-time default. */
  reset(): void {
    localStorage.removeItem(SERVER_BASE_URL_KEY);
    this.set({ baseUrl: DEFAULT_API_BASE_URL });
  }
}

function loadStoredBaseUrl(): string {
  const stored = localStorage.getItem(SERVER_BASE_URL_KEY);
  if (stored === null) return DEFAULT_API_BASE_URL;
  // Same origin-only check as save(), so the invariant holds even for values
  // persisted before it was enforced.
  try {
    return normalizeServerUrl(stored);
  } catch {
    return DEFAULT_API_BASE_URL;
  }
}

/**
 * Trims, strips a pasted `/v1` or `/v1/health` suffix, and validates that the
 * result is a bare http(s) origin. Path-bearing bases are rejected outright:
 * `deriveStreamUrl` replaces the path, so REST would work while the WebSocket
 * silently broke.
 */
function normalizeServerUrl(input: string): string {
  const trimmed = input
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1(\/health)?$/i, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Enter a valid http(s) URL, e.g. https://your-api.up.railway.app');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Enter a valid http(s) URL, e.g. https://your-api.up.railway.app');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(
      'Use just the server origin — no path, query, or credentials (e.g. https://your-api.up.railway.app)',
    );
  }
  return url.origin;
}
export interface HealthCheckResult {
  ok: boolean;
  message: string;
  baseUrl: string;
}

/** Probes `<baseUrl>/v1/health` so the user can verify a server before saving. */
export async function checkServerHealth(
  baseUrl: string,
  timeoutMs = 4000,
): Promise<HealthCheckResult> {
  let normalizedBaseUrl: string;
  try {
    normalizedBaseUrl = normalizeServerUrl(baseUrl);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      baseUrl: baseUrl.trim(),
    };
  }
  const url = `${normalizedBaseUrl}/v1/health`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      return {
        ok: false,
        message: `Server responded with HTTP ${response.status}`,
        baseUrl: normalizedBaseUrl,
      };
    }
    return { ok: true, message: 'Server reachable, API ok', baseUrl: normalizedBaseUrl };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return {
        ok: false,
        message: `Timed out after ${Math.round(timeoutMs / 1000)}s`,
        baseUrl: normalizedBaseUrl,
      };
    }
    return { ok: false, message: 'Server unreachable — check the URL', baseUrl: normalizedBaseUrl };
  }
}
