import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BrokerError, brokerErrors } from '../../common/broker-error';
import {
  EP,
  EndpointKey,
  parseErrorBody,
  WebullHosts,
} from './webull-endpoints';
import { compactJson, signRequest } from './webull-signer';

export interface WebullCredentials {
  appKey: string;
  appSecret: string;
  accountId: string;
}

/** Minimal fetch shape so tests can inject a mock. */
export type FetchImpl = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<{
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface WebullClientOptions {
  hosts: WebullHosts;
  fetchImpl?: FetchImpl;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests (deterministic nonces/timestamps). */
  uuid?: () => string;
  now?: () => Date;
}

interface CachedToken {
  token: string;
  /** epoch ms */
  expiresAt: number;
}

const TOKEN_REFRESH_MARGIN_MS = 2 * 86_400_000; // refresh 2d before ~15d expiry
const MAX_RATE_LIMIT_RETRIES = 4;
const BACKOFF_BASE_MS = 250;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * HTTP client for one Webull user (app key/secret + account id).
 *
 * - Auth: token create/refresh with an in-memory cache, refreshed well before
 *   expiry (tokens default to ~15-day life). New tokens may require approval
 *   in the Webull app (SMS) — surfaced as BROKER_AUTH_FAILED with guidance.
 *   NOTE: the cache is in-memory, so a production restart re-creates tokens
 *   (possible re-approval); DB-persisted tokens are a planned follow-up.
 * - Signing: every request signed via webull-signer.ts (validated against the
 *   official docs test vector).
 * - Resilience: 429 → exponential backoff with jitter (honoring Retry-After),
 *   one retry on 5xx, then mapped errors per docs/WEBULL-INTEGRATION.md §6.
 *
 * Plaintext credentials live only inside this class and are never logged.
 */
export class WebullClient {
  private readonly logger = new Logger(WebullClient.name);
  private readonly fetchImpl: FetchImpl;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly uuid: () => string;
  private readonly now: () => Date;
  private cachedToken: CachedToken | null = null;
  private tokenInFlight: Promise<string> | null = null;

  constructor(
    private readonly creds: WebullCredentials,
    private readonly options: WebullClientOptions,
  ) {
    this.fetchImpl = options.fetchImpl ?? (defaultFetch as FetchImpl);
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.uuid = options.uuid ?? (() => randomUUID());
    this.now = options.now ?? (() => new Date());
  }

  get accountId(): string {
    return this.creds.accountId;
  }

  /** Discard the cached token (e.g. after a 401 on a business call). */
  clearToken(): void {
    this.cachedToken = null;
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  async request(
    endpoint: EndpointKey,
    opts: {
      query?: Record<string, string>;
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
      skipAuth?: boolean;
    } = {},
  ): Promise<unknown> {
    const ep = EP[endpoint];
    const base =
      ep.host === 'api' ? this.options.hosts.api : this.options.hosts.data;
    const url = new URL(ep.path, base);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      url.searchParams.set(k, v);
    }

    let rateLimitAttempt = 0;
    let serverRetried = false;
    for (;;) {
      const token = opts.skipAuth ? undefined : await this.ensureToken();
      const { status, payload, retryAfter } = await this.send(
        ep.method,
        url,
        opts.body,
        token,
        opts.headers,
      );

      if (status === 429 && rateLimitAttempt < MAX_RATE_LIMIT_RETRIES) {
        const delay = retryAfter ?? this.backoffDelay(rateLimitAttempt);
        rateLimitAttempt += 1;
        this.logger.warn(
          `Webull 429 on ${ep.path}; retry ${rateLimitAttempt}/${MAX_RATE_LIMIT_RETRIES} in ${delay}ms`,
        );
        await this.sleep(delay);
        continue;
      }
      if (status >= 500 && !serverRetried) {
        serverRetried = true;
        await this.sleep(BACKOFF_BASE_MS);
        continue;
      }
      if (status >= 200 && status < 300) return payload;
      throw this.mapError(status, payload, ep.path);
    }
  }

  private async send(
    method: string,
    url: URL,
    body: Record<string, unknown> | undefined,
    accessToken: string | undefined,
    extraHeaders?: Record<string, string>,
  ): Promise<{
    status: number;
    payload: unknown;
    retryAfter?: number;
  }> {
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    const headers: Record<string, string> = {
      ...signRequest({
        appKey: this.creds.appKey,
        appSecret: this.creds.appSecret,
        host: url.host,
        path: url.pathname,
        query,
        body,
        accessToken,
        nonce: this.uuid(),
        timestamp: this.now().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      }),
      'content-type': 'application/json',
      ...extraHeaders,
    };

    let res: Awaited<ReturnType<FetchImpl>>;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers,
        // compactJson matches the bytes hashed into the signature.
        body: body !== undefined ? compactJson(body) : undefined,
      });
    } catch (err) {
      throw brokerErrors.unavailable(
        `Webull request failed: ${(err as Error).message}`,
      );
    }
    const payload = await res.json().catch(() => undefined);
    const retryAfterRaw = res.headers?.get('retry-after');
    const retryAfterSec = retryAfterRaw ? Number(retryAfterRaw) : NaN;
    return {
      status: res.status,
      payload,
      retryAfter: Number.isFinite(retryAfterSec)
        ? retryAfterSec * 1000
        : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Token lifecycle [verified: SDK token_manager.py]
  // -------------------------------------------------------------------------

  private async ensureToken(): Promise<string> {
    if (
      this.cachedToken &&
      this.cachedToken.expiresAt - this.now().getTime() >
        TOKEN_REFRESH_MARGIN_MS
    ) {
      return this.cachedToken.token;
    }
    // Single-flight: concurrent callers share one create/refresh.
    this.tokenInFlight ??= this.acquireToken().finally(() => {
      this.tokenInFlight = null;
    });
    return this.tokenInFlight;
  }

  private async acquireToken(): Promise<string> {
    const hadCached = this.cachedToken !== null;
    const path = hadCached ? EP.tokenRefresh.path : EP.tokenCreate.path;
    const body = hadCached ? { token: this.cachedToken!.token } : {};
    const payload = await this.requestToken(path, body);

    const token = this.readTokenPayload(payload);
    if (!token) {
      throw brokerErrors.authFailed(
        'Webull token response was malformed (missing token/expires/status)',
      );
    }
    if (token.status !== 'NORMAL') {
      // New tokens start PENDING (approval in the Webull app: Menu → Messages
      // → OpenAPI). Verified against the live API: a PENDING token still
      // serves account and market-data calls, so accept it and warn rather
      // than hard-failing every request.
      if (token.status === 'PENDING') {
        this.logger.warn(
          'Webull access token is PENDING approval in the Webull app (Menu → Messages → OpenAPI); using it anyway',
        );
      } else {
        throw brokerErrors.authFailed(
          `Webull access token is ${token.status}; approve it in the Webull app (Menu → Messages → OpenAPI) and retry`,
        );
      }
    }
    this.cachedToken = token;
    return token.token;
  }

  private async requestToken(
    path: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const url = new URL(path, this.options.hosts.api);
    let res: Awaited<ReturnType<FetchImpl>>;
    try {
      res = await this.fetchImpl(url.toString(), {
        method: 'POST',
        headers: {
          ...signRequest({
            appKey: this.creds.appKey,
            appSecret: this.creds.appSecret,
            host: url.host,
            path: url.pathname,
            query: {},
            body,
            nonce: this.uuid(),
            timestamp: this.now().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          }),
          'content-type': 'application/json',
        },
        body: compactJson(body),
      });
    } catch (err) {
      throw brokerErrors.unavailable(
        `Webull token request failed: ${(err as Error).message}`,
      );
    }
    const payload = await res.json().catch(() => undefined);
    if (res.status === 401 || res.status === 403) {
      throw brokerErrors.authFailed(
        'Webull rejected the app key/secret — re-enter credentials in the app',
      );
    }
    if (res.status < 200 || res.status >= 300) {
      const { code, message } = parseErrorBody(payload);
      throw new BrokerError(
        'BROKER_AUTH_FAILED',
        `Webull token request failed (${res.status})${code ? `: ${code}` : ''}${
          message ? ` — ${sanitize(message)}` : ''
        }`,
        401,
      );
    }
    return payload;
  }

  private readTokenPayload(
    raw: unknown,
  ): { token: string; expiresAt: number; status: string } | null {
    const d = (raw ?? {}) as Record<string, unknown>;
    const token =
      typeof d.token === 'string'
        ? d.token
        : typeof d.access_token === 'string'
          ? d.access_token
          : null;
    const status = typeof d.status === 'string' ? d.status : null;
    if (!token || status === null) return null;
    return { token, expiresAt: this.parseExpiry(d), status };
  }

  /** Tolerant expiry parsing (epoch s/ms, ISO, or expires_in). */
  private parseExpiry(d: Record<string, unknown>): number {
    if (typeof d.expires === 'number' && Number.isFinite(d.expires)) {
      return d.expires > 1e12 ? d.expires : d.expires * 1000;
    }
    if (typeof d.expires === 'string') {
      const parsed = Date.parse(d.expires);
      if (Number.isFinite(parsed)) return parsed;
    }
    if (typeof d.expires_in === 'number') {
      return this.now().getTime() + d.expires_in * 1000;
    }
    return this.now().getTime() + 13 * 86_400_000; // ~15d default validity
  }

  // -------------------------------------------------------------------------
  // Retry / error mapping (docs/WEBULL-INTEGRATION.md §6)
  // -------------------------------------------------------------------------

  private backoffDelay(attempt: number): number {
    const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, 4000);
    return Math.floor(base * (1 + Math.random()));
  }

  private mapError(status: number, payload: unknown, path: string): BrokerError {
    const { code, message } = parseErrorBody(payload);
    const haystack = `${code ?? ''} ${message ?? ''}`.toUpperCase();

    if (status === 401 || status === 403) {
      // Quote-subscription 401s ("Insufficient permission, please subscribe to
      // X quotes") are entitlements on the Webull app, not credential/token
      // failures — keep the token and surface the actionable message.
      if (
        haystack.includes('INSUFFICIENT PERMISSION') ||
        haystack.includes('SUBSCRIBE')
      ) {
        return brokerErrors.permissionDenied(
          `Webull market-data permission missing — ${sanitize(message)} ` +
            '(enable it for your app in the Webull OpenAPI console)',
        );
      }
      // A 401 may mean the cached token died — drop it so the next call
      // re-authenticates.
      this.clearToken();
      return brokerErrors.authFailed(
        'Webull rejected the request credentials/token',
      );
    }
    if (status === 429) {
      return brokerErrors.rateLimited(
        `Webull rate limit persisted after retries (${path})`,
      );
    }
    if (haystack.includes('BUYING_POWER') || haystack.includes('INSUFFICIENT')) {
      return brokerErrors.insufficientBuyingPower(sanitize(message));
    }
    if (
      haystack.includes('TRADING_TIME') ||
      haystack.includes('MARKET_CLOSED') ||
      haystack.includes('NOT_IN_TRADING') ||
      haystack.includes('TRADING_SESSION') ||
      haystack.includes('MARKET_NOT_OPEN') ||
      (haystack.includes('MARKET') && haystack.includes('CLOS'))
    ) {
      return brokerErrors.marketClosed(sanitize(message));
    }
    if (status === 400 || status === 417 || status === 422) {
      return brokerErrors.orderRejected(
        sanitize(message ?? (code ? `Webull error ${code}` : '')),
      );
    }
    return new BrokerError(
      'BROKER_ERROR',
      `Webull error ${status} on ${path}${code ? ` [${code}]` : ''}${
        message ? ` — ${sanitize(message)}` : ''
      }`,
      status >= 500 ? 503 : 400,
    );
  }
}

/** Message passthrough sanitized: bounded length, single line. */
function sanitize(message: string | undefined): string {
  return (message ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'Webull error';
}

/** Node 18 global fetch with a timeout. */
async function defaultFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; headers: Headers; json(): Promise<unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: controller.signal,
    });
    return {
      status: res.status,
      headers: res.headers,
      json: () => res.json() as Promise<unknown>,
    };
  } finally {
    clearTimeout(timer);
  }
}
