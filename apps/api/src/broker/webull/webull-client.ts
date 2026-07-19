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
  /** Absent until discovered via GET /openapi/account/list. */
  accountId?: string;
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
  /**
   * Optional persistence for the access token (official guidance: store and
   * reuse tokens). Loaded once lazily; every create/refresh/status change is
   * written back so a backend restart reuses the token instead of minting a
   * new one (which triggers a 2FA SMS on production).
   */
  tokenStore?: {
    load(): Promise<CachedToken | null>;
    save(token: CachedToken): Promise<void>;
    clear(): Promise<void>;
  };
}

export interface CachedToken {
  token: string;
  /** epoch ms */
  expiresAt: number;
  /** NORMAL | PENDING (awaiting in-app 2FA verification) */
  status: string;
}

const TOKEN_REFRESH_MARGIN_MS = 2 * 86_400_000; // refresh 2d before ~15d expiry
const MAX_RATE_LIMIT_RETRIES = 4;
const BACKOFF_BASE_MS = 250;
const REQUEST_TIMEOUT_MS = 10_000;
/** Min interval between token/check polls while a token is PENDING. */
const STATUS_CHECK_INTERVAL_MS = 20_000;

/** Guidance shown while a PENDING token awaits in-app verification. */
const PENDING_GUIDANCE =
  'Webull token is awaiting verification — in the Webull app go to ' +
  'Menu → Messages → OpenAPI Notifications → Check Now and enter the SMS code';

/**
 * HTTP client for one Webull user (app key/secret + account id).
 *
 * - Auth: token create/refresh with an in-memory cache, refreshed well before
 *   expiry (tokens default to ~15-day life). A token is created ONCE and
 *   reused; a PENDING token (2FA: SMS code entered in the Webull app) is
 *   kept and its status polled via token/check — it is never replaced
 *   automatically, because every create triggers a fresh 2FA challenge and
 *   repeated creates lock the account (VERIFY_FAILURE_EXCEED_LIMIT). After
 *   an auth failure the client latches and only reauthenticate() (the app's
 *   Reconnect button) mints a new token. With a tokenStore configured, the
 *   cache hydrates from persistence on first use and every create/refresh/
 *   status change is written back — restarts reuse the stored token instead
 *   of re-creating one (official guidance: store and reuse tokens).
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
  /** Consecutive token-acquire failures driving the backoff below. */
  private tokenFailures = 0;
  /** Epoch ms before which no new token create/refresh is attempted. */
  private tokenRetryAfterMs = 0;
  /**
   * Auth-failure latch. Once a token create/refresh is rejected (or a
   * business call 401s a NORMAL token), every further call fails fast with
   * this message and NO token endpoint is touched again until the user
   * presses Reconnect (reauthenticate). Repeated token creates each trigger
   * a fresh Webull 2FA approval and can lock the account
   * (VERIFY_FAILURE_EXCEED_LIMIT), so automatic re-creation is never done.
   */
  private reauthRequired: string | null = null;
  /** Epoch ms before which no token/check poll is attempted (PENDING wait). */
  private nextStatusCheckMs = 0;
  /** One-shot hydration of the cache from the persisted token store. */
  private storeHydration: Promise<void> | null = null;

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
    if (!this.creds.accountId) {
      throw brokerErrors.authFailed(
        'Webull account id not yet discovered — authenticate first',
      );
    }
    return this.creds.accountId;
  }

  hasAccountId(): boolean {
    return Boolean(this.creds.accountId);
  }

  /** Set the account id discovered via GET /openapi/account/list. */
  setAccountId(accountId: string): void {
    this.creds.accountId = accountId;
  }

  /** Discard the cached token (used by reauthenticate before a fresh create). */
  clearToken(): void {
    this.cachedToken = null;
  }

  /**
   * Force a brand-new access token (full create, not refresh) on demand —
   * the server side of the app's "Reconnect" button, for when the user's
   * token went stale and they don't want to re-enter credentials. This is
   * the ONLY path that creates a token after an auth failure.
   */
  async reauthenticate(): Promise<void> {
    this.reauthRequired = null;
    this.tokenFailures = 0;
    this.tokenRetryAfterMs = 0;
    this.nextStatusCheckMs = 0;
    this.clearToken();
    // Skip hydration: the persisted token is the stale one being replaced.
    this.storeHydration = Promise.resolve();
    await this.options.tokenStore?.clear();
    await this.ensureToken();
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
    // First call on a fresh client: pull the persisted token (if any) into
    // the in-memory cache so restarts reuse it instead of re-creating.
    if (this.options.tokenStore && !this.storeHydration) {
      this.storeHydration = this.options.tokenStore.load().then((persisted) => {
        if (persisted && !this.cachedToken) {
          this.cachedToken = persisted;
          this.logger.log(
            `Webull access token restored from store (status ${persisted.status})`,
          );
        }
      });
    }
    if (this.storeHydration) await this.storeHydration;

    const cached = this.cachedToken;
    if (
      cached &&
      cached.expiresAt - this.now().getTime() > TOKEN_REFRESH_MARGIN_MS
    ) {
      if (cached.status === 'NORMAL') return cached.token;
      if (cached.status === 'PENDING') {
        return this.awaitPendingVerification(cached);
      }
    }
    // Latch: an earlier auth failure requires the user's explicit Reconnect.
    // No HTTP call is made — per-second quote ticks fail fast locally.
    if (this.reauthRequired) {
      throw brokerErrors.authFailed(this.reauthRequired);
    }
    // Backoff gate for TRANSIENT acquire failures (network/5xx) so quote
    // ticks can't hammer the token endpoint (~10 creates/30s allowed).
    if (this.now().getTime() < this.tokenRetryAfterMs) {
      throw brokerErrors.rateLimited(
        'Webull token creation is backing off after a network failure — retry in a minute',
      );
    }
    // Single-flight: concurrent callers share one create/refresh.
    this.tokenInFlight ??= this.acquireToken()
      .then((token) => {
        this.tokenFailures = 0;
        return token;
      })
      .catch((err) => {
        if (err instanceof BrokerError && err.code === 'BROKER_AUTH_FAILED') {
          // Auth-class failures need a human (approve 2FA in the Webull app,
          // then Reconnect) — latch instead of retrying and re-triggering
          // 2FA challenges until the account locks.
          this.reauthRequired =
            `${err.message} — approve in the Webull app ` +
            '(Menu → Messages → OpenAPI Notifications), then press Reconnect in Profile';
        } else {
          this.tokenFailures += 1;
          const backoff = Math.min(1000 * 2 ** this.tokenFailures, 60_000);
          this.tokenRetryAfterMs = this.now().getTime() + backoff;
          this.logger.warn(
            `Webull token acquire failed (${this.tokenFailures}x); backing off ${backoff}ms`,
          );
        }
        throw err;
      })
      .finally(() => {
        this.tokenInFlight = null;
      });
    return this.tokenInFlight;
  }

  /**
   * A PENDING token is cached and reused while the user completes 2FA in the
   * Webull app (official flow: create → PENDING + SMS → verify in app →
   * NORMAL). Verified live: PENDING tokens serve API calls, so they are
   * attached optimistically while token/check is polled at most once per
   * STATUS_CHECK_INTERVAL_MS for the flip to NORMAL. A token that flips
   * EXPIRED/INVALID (5-minute verification window lapsed) latches — only
   * Reconnect mints a new one.
   */
  private async awaitPendingVerification(cached: CachedToken): Promise<string> {
    if (this.now().getTime() >= this.nextStatusCheckMs) {
      this.nextStatusCheckMs = this.now().getTime() + STATUS_CHECK_INTERVAL_MS;
      const status = await this.checkTokenStatus(cached.token);
      if (status === 'NORMAL') {
        this.cachedToken = { ...cached, status: 'NORMAL' };
        await this.options.tokenStore?.save(this.cachedToken);
        this.logger.log('Webull access token verified — status NORMAL');
      } else if (status !== 'PENDING' && status !== null) {
        this.cachedToken = null;
        await this.options.tokenStore?.clear();
        this.reauthRequired =
          'Webull token verification expired (5-minute window) — ' +
          'press Reconnect in Profile and approve in the Webull app';
        throw brokerErrors.authFailed(this.reauthRequired);
      }
    }
    return cached.token;
  }

  /** token/check → uppercase status, or null when the shape is unknown or
   *  the call failed (treated as "still waiting"). */
  private async checkTokenStatus(token: string): Promise<string | null> {
    try {
      const payload = await this.requestToken(EP.tokenCheck.path, { token });
      const d = (payload ?? {}) as Record<string, unknown>;
      if (typeof d.status === 'string') return d.status.toUpperCase();
      // One level of nesting tolerance (e.g. { data: { status } }).
      for (const value of Object.values(d)) {
        if (value && typeof value === 'object') {
          const s = (value as Record<string, unknown>).status;
          if (typeof s === 'string') return s.toUpperCase();
        }
      }
      return null;
    } catch {
      return null;
    }
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
    await this.options.tokenStore?.save(token);
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
    const isTradeEndpoint = path.includes('/trade/');

    // Quote-subscription denials ("Insufficient permission, please subscribe
    // to X quotes") are entitlements on the Webull app, not credential/token
    // failures and never a buying-power problem — regardless of the status
    // they arrive with, keep the token and surface the actionable message.
    if (
      haystack.includes('INSUFFICIENT PERMISSION') ||
      haystack.includes('SUBSCRIBE')
    ) {
      return brokerErrors.permissionDenied(
        `Webull market-data permission missing — ${sanitize(message)} ` +
          '(enable it for your app in the Webull OpenAPI console)',
      );
    }

    if (status === 401 || status === 403) {
      // Never auto-create a replacement token: every create on production can
      // trigger a fresh 2FA approval, so churn here is what locks accounts
      // (VERIFY_FAILURE_EXCEED_LIMIT). A PENDING token is likely just
      // awaiting the user's in-app verification — keep it; ensureToken's
      // bounded token/check polling notices the flip to NORMAL. A NORMAL
      // token being rejected means it died server-side: latch until the
      // user presses Reconnect.
      if (this.cachedToken?.status === 'PENDING') {
        return brokerErrors.authFailed(PENDING_GUIDANCE);
      }
      this.reauthRequired =
        'Webull rejected the access token — press Reconnect in Profile to mint a new one';
      return brokerErrors.authFailed(this.reauthRequired);
    }
    if (status === 429) {
      return brokerErrors.rateLimited(
        `Webull rate limit persisted after retries (${path})`,
      );
    }
    // Buying-power failures only make sense on order endpoints; a 400 from
    // /market-data/* mentioning "insufficient" is a parameter problem.
    if (
      isTradeEndpoint &&
      (haystack.includes('BUYING_POWER') || haystack.includes('INSUFFICIENT'))
    ) {
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
    if (isTradeEndpoint && (status === 400 || status === 417 || status === 422)) {
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
