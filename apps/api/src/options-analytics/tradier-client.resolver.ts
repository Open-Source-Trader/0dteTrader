import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TradingMode } from '@0dtetrader/shared-types';
import { CredentialsService } from '../credentials/credentials.service';
import { PrismaService } from '../prisma/prisma.service';
import { TradierClient } from './tradier.client';

/** Tradier's sandbox host — practice keys are only valid against it. */
export const TRADIER_SANDBOX_BASE_URL = 'https://sandbox.tradier.com';

export interface ResolvedTradier {
  client: TradierClient;
  /**
   * Cache-scoping token: 'shared' for the env-token client, a secrets
   * fingerprint prefix for per-user clients. Consumers MUST key any cache
   * shared across users by this scope — a sandbox key returns delayed
   * sandbox data that must never be served to another user's live view.
   */
  scope: string;
}

export type TradierFactory = (token: string, baseUrl: string) => TradierClient;

/**
 * Resolves the Tradier client for a request: the calling user's stored
 * per-user API key when one exists (spreading Tradier's per-token rate limit
 * across users), falling back to the shared TRADIER_API_TOKEN client.
 *
 * Key selection by the user's trading mode:
 *  - live mode uses the stored live key only — a sandbox key's delayed data
 *    must not back live trading;
 *  - practice mode prefers the sandbox key (sandbox base URL) but falls back
 *    to the live key, whose production data is strictly better.
 *
 * Per-user clients are cached and keyed by a fingerprint of the secrets
 * (AlpacaBrokerGateway pattern), so a re-saved key rebuilds the client and
 * its rate-limit state. Resolutions (including "no key") are memoized for
 * RESOLUTION_TTL_MS, so the hot market-data path pays no per-request DB
 * reads and a key save/delete takes effect within a few seconds. Callers
 * with no user context (capture cron, the shared index-quote poll in
 * StreamGateway) resolve to the shared client.
 */
@Injectable()
export class TradierClientResolver {
  /** How long a resolution (positive or negative) is trusted before the DB
   *  is re-read. Bounds a key save/delete to a few seconds of staleness while
   *  keeping the hot market-data path free of per-request DB reads. */
  private static readonly RESOLUTION_TTL_MS = 5_000;
  /** Fingerprint stored for a cached "no key" resolution. */
  private static readonly NO_KEY = 'none';

  private readonly logger = new Logger(TradierClientResolver.name);
  private readonly clients = new Map<
    string,
    { fingerprint: string; resolved: ResolvedTradier; refreshedAt: number }
  >();
  private readonly shared: ResolvedTradier;

  constructor(
    private readonly config: ConfigService,
    private readonly credentials: CredentialsService,
    private readonly prisma: PrismaService,
    sharedClient: TradierClient,
    private readonly factory: TradierFactory = (token, baseUrl) =>
      new TradierClient(token, baseUrl),
  ) {
    this.shared = { client: sharedClient, scope: 'shared' };
  }

  async resolve(userId?: string): Promise<ResolvedTradier> {
    if (!userId) return this.shared;
    const now = Date.now();
    const cached = this.clients.get(userId);
    if (cached && now - cached.refreshedAt < TradierClientResolver.RESOLUTION_TTL_MS) {
      return cached.resolved;
    }
    try {
      const secrets = await this.storedKeyFor(userId);
      if (!secrets) {
        this.clients.set(userId, {
          fingerprint: TradierClientResolver.NO_KEY,
          resolved: this.shared,
          refreshedAt: now,
        });
        return this.shared;
      }
      const fingerprint = createHash('sha256')
        .update(`${secrets.environment}:${secrets.apiKey}`)
        .digest('hex');
      if (cached?.fingerprint === fingerprint) {
        cached.refreshedAt = now;
        return cached.resolved;
      }
      const baseUrl =
        secrets.environment === 'practice'
          ? TRADIER_SANDBOX_BASE_URL
          : this.config.get<string>('tradier.baseUrl') || 'https://api.tradier.com';
      const resolved: ResolvedTradier = {
        client: this.factory(secrets.apiKey, baseUrl),
        scope: fingerprint.slice(0, 16),
      };
      this.clients.set(userId, { fingerprint, resolved, refreshedAt: now });
      return resolved;
    } catch (err) {
      // A broken stored key (corrupt blob, DB read failure) must degrade to
      // the shared env client, not take market data down for the user.
      this.logger.warn(
        `Falling back to the shared Tradier client: ${(err as Error).message ?? err}`,
      );
      return this.shared;
    }
  }

  private async storedKeyFor(
    userId: string,
  ): Promise<{ apiKey: string; environment: TradingMode } | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const mode: TradingMode = user?.tradingMode === 'practice' ? 'practice' : 'live';
    const environments: TradingMode[] = mode === 'practice' ? ['practice', 'live'] : ['live'];
    for (const environment of environments) {
      const stored = await this.credentials.getDecrypted(userId, 'tradier', environment);
      if (stored?.provider === 'tradier' && stored.apiKey) {
        return { apiKey: stored.apiKey, environment };
      }
    }
    return null;
  }
}
