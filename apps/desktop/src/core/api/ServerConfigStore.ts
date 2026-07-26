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
  return stored !== null && isHttpUrl(stored) ? stored : DEFAULT_API_BASE_URL;
}

/** Trims, strips trailing `/` and a pasted `/v1` suffix, validates http(s). */
function normalizeServerUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '');
  if (url.endsWith('/v1')) url = url.slice(0, -'/v1'.length);
  if (!isHttpUrl(url)) {
    throw new Error('Enter a valid http(s) URL, e.g. https://your-api.up.railway.app');
  }
  return url;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface HealthCheckResult {
  ok: boolean;
  message: string;
}

/** Probes `<baseUrl>/v1/health` so the user can verify a server before saving. */
export async function checkServerHealth(
  baseUrl: string,
  timeoutMs = 4000,
): Promise<HealthCheckResult> {
  let url: string;
  try {
    url = `${normalizeServerUrl(baseUrl)}/v1/health`;
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      return { ok: false, message: `Server responded with HTTP ${response.status}` };
    }
    return { ok: true, message: 'Server reachable, API ok' };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return { ok: false, message: `Timed out after ${Math.round(timeoutMs / 1000)}s` };
    }
    return { ok: false, message: 'Server unreachable — check the URL' };
  }
}
