import type { AuthTokens } from '@0dtetrader/shared-types';
import { ApiError, parseErrorEnvelope } from './ApiError';

const REFRESH_TOKEN_KEY = '0dte.refreshToken';

/**
 * Token lifecycle (SessionStore.swift analog): access token in memory only,
 * refresh token in localStorage (the Keychain analog for this dev/test tool).
 * Concurrent refresh calls share one in-flight request.
 */
export class SessionStore {
  private accessToken: string | null = null;
  private refreshPromise: Promise<AuthTokens> | null = null;
  private unauthenticatedListeners = new Set<() => void>();

  constructor(private readonly baseUrl: string) {}

  onUnauthenticated(listener: () => void): () => void {
    this.unauthenticatedListeners.add(listener);
    return () => this.unauthenticatedListeners.delete(listener);
  }

  currentAccessToken(): string | null {
    return this.accessToken;
  }

  hasStoredRefreshToken(): boolean {
    return localStorage.getItem(REFRESH_TOKEN_KEY) !== null;
  }

  /** Stores freshly issued tokens after register/login. */
  signIn(tokens: AuthTokens): void {
    this.accessToken = tokens.accessToken;
    localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
  }

  /** Attempts to restore a session from the stored refresh token (app launch). */
  async restoreSession(): Promise<boolean> {
    if (!this.hasStoredRefreshToken()) return false;
    try {
      await this.refreshAccessToken();
      return true;
    } catch {
      return false;
    }
  }

  /** Returns a usable access token, refreshing first if none is in memory. */
  async accessTokenOrRefresh(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    return this.refreshAccessToken();
  }

  /** Forces a refresh. Concurrent calls await the same in-flight request. */
  async refreshAccessToken(): Promise<string> {
    if (this.refreshPromise) {
      return (await this.refreshPromise).accessToken;
    }
    const promise = this.performRefresh();
    this.refreshPromise = promise;
    try {
      const tokens = await promise;
      this.accessToken = tokens.accessToken;
      // Rotation: the server issues a new refresh token every time.
      localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
      return tokens.accessToken;
    } catch (error) {
      if (ApiError.isUnauthorized(error)) {
        this.clearLocalSession();
        this.unauthenticatedListeners.forEach((listener) => listener());
      }
      throw error;
    } finally {
      this.refreshPromise = null;
    }
  }

  /** Logs out server-side (best effort) and wipes local tokens. */
  async signOut(): Promise<void> {
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
    this.clearLocalSession();
    if (!refreshToken) return;
    try {
      await fetch(`${this.baseUrl}/v1/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      // Best effort only.
    }
  }

  private clearLocalSession(): void {
    this.accessToken = null;
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  }

  // Raw fetch (not ApiClient) to avoid recursion through the 401-retry path.
  private async performRefresh(): Promise<AuthTokens> {
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
    if (!refreshToken) throw new ApiError({ kind: 'unauthorized' });

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new ApiError({ kind: 'network', underlying: errorText(error) });
    }

    if (!response.ok) {
      if (response.status === 401) throw new ApiError({ kind: 'unauthorized' });
      const body = await response.json().catch(() => null);
      const envelope = parseErrorEnvelope(body);
      if (envelope) {
        throw new ApiError({
          kind: 'server',
          code: envelope.code,
          message: envelope.message,
          status: response.status,
        });
      }
      throw new ApiError({ kind: 'httpStatus', status: response.status });
    }
    try {
      return (await response.json()) as AuthTokens;
    } catch {
      throw new ApiError({ kind: 'decoding' });
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
