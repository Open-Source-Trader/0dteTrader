import { Injectable, Logger } from '@nestjs/common';
import { WebullCredentialsInput } from '@0dtetrader/shared-types';
import { brokerErrors } from '../../common/broker-error';
import { CryptoService } from '../../credentials/crypto.service';
import { PrismaService } from '../../prisma/prisma.service';
import { WebullHttpClient } from './webull-http.client';

/** Recreate/refresh when less than this much validity remains. */
const REFRESH_MARGIN_MS = 2 * 86_400_000; // 2 days of the ~15-day validity
const DEFAULT_VALIDITY_MS = 13 * 86_400_000;

interface WebullTokenResponse {
  token?: string;
  access_token?: string;
  expires?: number | string;
  expires_in?: number;
  status?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * Per-user Webull API token lifecycle: create → cache (memory + encrypted DB
 * row) → refresh before expiry. Persisted across restarts because production
 * token creation triggers SMS verification in the user's Webull app; sandbox
 * tokens are NORMAL immediately.
 */
@Injectable()
export class WebullTokenStore {
  private readonly logger = new Logger(WebullTokenStore.name);
  private readonly cache = new Map<string, CachedToken>();
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(
    private readonly http: WebullHttpClient,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async getToken(
    userId: string,
    creds: WebullCredentialsInput,
  ): Promise<string> {
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
      return cached.token;
    }
    const pending = this.inFlight.get(userId);
    if (pending) return pending;

    const promise = this.resolveToken(userId, creds).finally(() =>
      this.inFlight.delete(userId),
    );
    this.inFlight.set(userId, promise);
    return promise;
  }

  /** Drops the cached token (memory + DB), e.g. after a 401 on a business call. */
  async invalidate(userId: string): Promise<void> {
    this.cache.delete(userId);
    await this.prisma.webullApiToken
      .delete({ where: { userId } })
      .catch(() => undefined);
  }

  private async resolveToken(
    userId: string,
    creds: WebullCredentialsInput,
  ): Promise<string> {
    const row = await this.prisma.webullApiToken.findUnique({
      where: { userId },
    });
    if (row) {
      const remaining = row.expiresAt.getTime() - Date.now();
      const token = this.crypto.decrypt(row.encToken);
      if (remaining > REFRESH_MARGIN_MS) {
        this.cache.set(userId, { token, expiresAt: row.expiresAt.getTime() });
        return token;
      }
      if (remaining > 0) {
        try {
          return await this.refresh(userId, creds, token);
        } catch {
          this.logger.warn('Webull token refresh failed; creating a new token');
        }
      }
    }
    return this.create(userId, creds);
  }

  private async create(
    userId: string,
    creds: WebullCredentialsInput,
  ): Promise<string> {
    const res = await this.http.request<WebullTokenResponse>({
      method: 'POST',
      path: '/openapi/auth/token/create',
      body: {},
      appKey: creds.appKey,
      appSecret: creds.appSecret,
    });
    return this.store(userId, res);
  }

  private async refresh(
    userId: string,
    creds: WebullCredentialsInput,
    currentToken: string,
  ): Promise<string> {
    const res = await this.http.request<WebullTokenResponse>({
      method: 'POST',
      path: '/openapi/auth/token/refresh',
      body: {},
      appKey: creds.appKey,
      appSecret: creds.appSecret,
      accessToken: currentToken,
    });
    return this.store(userId, res);
  }

  private async store(
    userId: string,
    res: WebullTokenResponse,
  ): Promise<string> {
    const token = res.token ?? res.access_token;
    const status = (res.status ?? 'NORMAL').toUpperCase();
    if (status === 'PENDING') {
      throw brokerErrors.authFailed(
        'Webull OpenAPI token awaiting approval — open the Webull app ' +
          '(Menu → Messages → OpenAPI Notifications), approve within 5 minutes, then retry',
      );
    }
    if (!token || (status !== 'NORMAL' && status !== '')) {
      throw brokerErrors.authFailed(
        `Webull token creation failed (status ${status || 'unknown'})`,
      );
    }
    const expiresAt = parseExpiry(res);
    await this.prisma.webullApiToken.upsert({
      where: { userId },
      create: {
        userId,
        encToken: this.crypto.encrypt(token),
        expiresAt: new Date(expiresAt),
        status,
      },
      update: {
        encToken: this.crypto.encrypt(token),
        expiresAt: new Date(expiresAt),
        status,
      },
    });
    this.cache.set(userId, { token, expiresAt });
    return token;
  }
}

/** Tolerant expiry parsing — exact field shape is confirmed against sandbox. */
function parseExpiry(res: WebullTokenResponse): number {
  if (typeof res.expires === 'number') {
    // Epoch seconds vs milliseconds.
    return res.expires > 1e12 ? res.expires : res.expires * 1000;
  }
  if (typeof res.expires === 'string') {
    const parsed = Date.parse(res.expires);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof res.expires_in === 'number') {
    return Date.now() + res.expires_in * 1000;
  }
  return Date.now() + DEFAULT_VALIDITY_MS;
}
