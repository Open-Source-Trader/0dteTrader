import { Logger } from '@nestjs/common';
import { BrokerError, brokerErrors } from '../../common/broker-error';
import { AlpacaHosts, EndpointKey, EP } from './alpaca-endpoints';

export interface AlpacaSecrets {
  apiKey: string;
  apiSecret: string;
}

/** Minimal fetch shape so tests can inject a mock (same contract as Webull). */
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

export interface AlpacaClientOptions {
  hosts: AlpacaHosts;
  fetchImpl?: FetchImpl;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const MAX_RATE_LIMIT_RETRIES = 4;
const BACKOFF_BASE_MS = 250;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * HTTP client for one Alpaca user (API key/secret) on one environment.
 *
 * - Auth: HTTP Basic (key:secret), set once per request. No token lifecycle,
 *   no HMAC signer, no SMS 2FA — Alpaca keys are effectively long-lived, so
 *   `reauthenticate` is a no-op at the gateway level.
 * - Resilience: 429 → exponential backoff with jitter (honoring Retry-After),
 *   one retry on 5xx, then mapped errors. A 10s request timeout protects the
 *   per-second quote ticks used by the stream gateway.
 *
 * Plaintext secrets live only inside this class and are never logged.
 */
export class AlpacaClient {
  private readonly logger = new Logger(AlpacaClient.name);
  private readonly fetchImpl: FetchImpl;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly secrets: AlpacaSecrets,
    private readonly options: AlpacaClientOptions,
  ) {
    this.fetchImpl = options.fetchImpl ?? (defaultFetch as FetchImpl);
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async request(
    endpoint: EndpointKey,
    opts: {
      query?: Record<string, string>;
      body?: Record<string, unknown>;
      /**
       * Override the path template token (e.g. {id} → an order id, or
       * {clientId} → a client_order_id). Present because Alpaca's order
       * cancel has no path params in the static EP table.
       */
      pathParams?: Record<string, string>;
    } = {},
  ): Promise<unknown> {
    const ep = EP[endpoint];
    const base = ep.host === 'trading' ? this.options.hosts.trading : this.options.hosts.data;
    let path: string = ep.path;
    if (opts.pathParams) {
      for (const [k, v] of Object.entries(opts.pathParams)) {
        path = path.replace(`{${k}}`, encodeURIComponent(v));
      }
    }
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v);
    }

    let rateLimitAttempt = 0;
    let serverRetried = false;
    for (;;) {
      const { status, payload, retryAfter } = await this.send(ep.method, url, opts.body);

      if (status === 429 && rateLimitAttempt < MAX_RATE_LIMIT_RETRIES) {
        const delay = retryAfter ?? this.backoffDelay(rateLimitAttempt);
        rateLimitAttempt += 1;
        this.logger.warn(
          `Alpaca 429 on ${ep.path}; retry ${rateLimitAttempt}/${MAX_RATE_LIMIT_RETRIES} in ${delay}ms`,
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
  ): Promise<{ status: number; payload: unknown; retryAfter?: number }> {
    const headers: Record<string, string> = {
      Authorization: this.basicAuth(),
      Accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    };
    let res: Awaited<ReturnType<FetchImpl>>;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw brokerErrors.unavailable(`Alpaca request failed: ${(err as Error).message}`);
    }
    const payload = await res.json().catch(() => undefined);
    const retryAfterRaw = res.headers?.get('retry-after');
    const retryAfterSec = retryAfterRaw ? Number(retryAfterRaw) : NaN;
    return {
      status: res.status,
      payload,
      retryAfter: Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : undefined,
    };
  }

  /** Basic auth value: base64(key:secret). */
  private basicAuth(): string {
    const raw = `${this.secrets.apiKey}:${this.secrets.apiSecret}`;
    return `Basic ${Buffer.from(raw).toString('base64')}`;
  }

  private backoffDelay(attempt: number): number {
    const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, 4000);
    return Math.floor(base * (1 + Math.random()));
  }

  private mapError(status: number, payload: unknown, path: string): BrokerError {
    const d = (payload ?? {}) as Record<string, unknown>;
    const code = typeof d.code === 'string' ? d.code : undefined;
    const message = typeof d.message === 'string' ? d.message : undefined;
    const haystack = `${code ?? ''} ${message ?? ''}`.toUpperCase();

    if (status === 401 || status === 403) {
      // 401 → bad key/secret (the Webull-equivalent "re-enter credentials").
      // Could also be an IP allow-list rejection; surface the message.
      return brokerErrors.authFailed(
        `Alpaca rejected the API key/secret — check your credentials${
          message ? ` (${message})` : ''
        }`,
      );
    }
    if (status === 429) {
      return brokerErrors.rateLimited(`Alpaca rate limit persisted after retries (${path})`);
    }
    if (status === 422 || status === 400) {
      if (haystack.includes('INSUFFICIENT') || haystack.includes('BUYING_POWER')) {
        return brokerErrors.insufficientBuyingPower(message ?? 'Alpaca buying-power check failed');
      }
      return brokerErrors.orderRejected(
        message ?? (code ? `Alpaca error ${code}` : 'Order rejected'),
      );
    }
    if (
      haystack.includes('MARKET_CLOSED') ||
      haystack.includes('NOT_TRADABLE') ||
      haystack.includes('OUTSIDE_REGULAR') ||
      haystack.includes('CLOSED')
    ) {
      return brokerErrors.marketClosed(message ?? 'Market is closed for this contract');
    }
    if (haystack.includes('NOT_FOUND') || haystack.includes('DOES_NOT_EXIST')) {
      return brokerErrors.contractNotFound(message ?? `Alpaca contract not found (${path})`);
    }
    return new BrokerError(
      'BROKER_ERROR',
      `Alpaca error ${status} on ${path}${code ? ` [${code}]` : ''}${
        message ? ` — ${message}` : ''
      }`,
      status >= 500 ? 503 : 400,
    );
  }
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
