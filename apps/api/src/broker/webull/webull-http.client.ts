import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrokerError, brokerErrors } from '../../common/broker-error';
import { compactJson, signRequest } from './webull-signer';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RATE_LIMIT_RETRIES = 4;
const BACKOFF_BASE_MS = 250;

export interface WebullRequestOptions {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  appKey: string;
  appSecret: string;
  accessToken?: string;
  /** Market-data endpoints may live on a separate host. */
  hostKind?: 'api' | 'marketData';
}

interface WebullErrorBody {
  code?: string;
  /** Observed live: sandbox 401s use error_code (e.g. UNAUTHORIZED). */
  error_code?: string;
  message?: string;
  msg?: string;
}

/**
 * Maps a Webull business-error code/message to the project's broker errors
 * (docs/WEBULL-INTEGRATION.md §6). One table so live corrections are local.
 * Exact Webull codes are verified against sandbox; matching is by substring
 * on the upper-cased code+message.
 */
export function mapWebullError(
  status: number,
  code: string,
  message: string,
): BrokerError {
  if (status === 401 || status === 403) {
    return brokerErrors.authFailed(
      'Webull rejected the request credentials/token',
    );
  }
  if (status === 429) {
    return brokerErrors.rateLimited();
  }
  const haystack = `${code} ${message}`.toUpperCase();
  if (haystack.includes('BUYING_POWER') || haystack.includes('INSUFFICIENT')) {
    return brokerErrors.insufficientBuyingPower(sanitize(message));
  }
  if (
    haystack.includes('TRADING_TIME') ||
    haystack.includes('MARKET_CLOSED') ||
    haystack.includes('NOT_IN_TRADING') ||
    haystack.includes('TRADING_SESSION') ||
    haystack.includes('MARKET_NOT_OPEN')
  ) {
    return brokerErrors.marketClosed(sanitize(message));
  }
  return brokerErrors.orderRejected(sanitize(message || code || 'Webull error'));
}

/** Message passthrough sanitized: bounded length, single line. */
function sanitize(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, 200) || 'Webull error';
}

/**
 * The single choke point for all Webull HTTP calls: signs each request,
 * applies timeouts, retries 429s with exponential backoff (+ Retry-After),
 * retries 5xx once, and maps error responses to BrokerError. Never logs
 * headers, credentials, or tokens.
 */
@Injectable()
export class WebullHttpClient {
  private readonly logger = new Logger(WebullHttpClient.name);

  constructor(private readonly config: ConfigService) {}

  async request<T>(opts: WebullRequestOptions): Promise<T> {
    const baseUrl =
      opts.hostKind === 'marketData'
        ? this.config.get<string>('webull.marketDataBaseUrl')!
        : this.config.get<string>('webull.apiBaseUrl')!;
    const url = new URL(opts.path, baseUrl);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let attempt = 0;
    let serverRetried = false;
    for (;;) {
      const response = await this.send(url, baseUrl, opts);

      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : BACKOFF_BASE_MS * 2 ** attempt * (1 + Math.random());
        attempt += 1;
        this.logger.warn(
          `Webull 429 on ${opts.path}; retry ${attempt}/${MAX_RATE_LIMIT_RETRIES} in ${Math.round(delay)}ms`,
        );
        await sleep(delay);
        continue;
      }
      if (response.status >= 500 && !serverRetried) {
        serverRetried = true;
        await sleep(BACKOFF_BASE_MS);
        continue;
      }

      if (response.ok) {
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      let body: WebullErrorBody = {};
      try {
        body = (await response.json()) as WebullErrorBody;
      } catch {
        // Non-JSON error body — mapped from status alone.
      }
      throw mapWebullError(
        response.status,
        body.code ?? body.error_code ?? '',
        body.message ?? body.msg ?? '',
      );
    }
  }

  private async send(
    url: URL,
    baseUrl: string,
    opts: WebullRequestOptions,
  ): Promise<Response> {
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    const headers: Record<string, string> = {
      ...signRequest({
        appKey: opts.appKey,
        appSecret: opts.appSecret,
        host: new URL(baseUrl).host,
        path: url.pathname,
        query,
        body: opts.body,
        accessToken: opts.accessToken,
      }),
      'content-type': 'application/json',
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      return await fetch(url, {
        method: opts.method,
        headers,
        // compactJson matches the bytes hashed into the signature.
        body: opts.body !== undefined ? compactJson(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw brokerErrors.unavailable(
          `Webull request timed out after ${REQUEST_TIMEOUT_MS}ms`,
        );
      }
      this.logger.error(`Webull request failed: ${(err as Error).message}`);
      throw brokerErrors.unavailable();
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as NodeJS.Timeout).unref?.();
  });
}
