import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TradingMode } from '@0dtetrader/shared-types';
import { errors } from '../common/api-exception';
import { CredentialsService } from '../credentials/credentials.service';
import { PrismaService } from '../prisma/prisma.service';
import { TradierClient } from './tradier.client';

/** Tradier's sandbox host — practice keys are only valid against it. */
export const TRADIER_SANDBOX_BASE_URL = 'https://sandbox.tradier.com';

/** TradierClient throws `Tradier <path> -> HTTP <status>`; 401/403 mean the
 *  token itself was rejected (revoked, typo'd, wrong environment). */
const TRADIER_AUTH_ERROR = /-> HTTP 40[13]\b/;

export interface ResolvedTradier {
  client: TradierClient;
  /**
   * Cache-scoping token: 'shared' for the env-token client, an opaque
   * random token minted per built client otherwise (deliberately NOT
   * derived from the secret). Consumers MUST key any cache shared across
   * users by this scope — a sandbox key returns delayed sandbox data that
   * must never be served to another user's live view.
   */
  scope: string;
}

export type TradierFactory = (token: string, baseUrl: string) => TradierClient;

interface ResolutionEntry {
  /** `environment:apiKey` for a built client, null for a "no key" resolution. */
  credential: string | null;
  resolved: ResolvedTradier;
  refreshedAt: number;
}

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
 * Per-user clients are cached per user and rebuilt when the stored secret
 * changes — detected by direct comparison against the cached credential
 * (the plaintext already lives inside the client instance, and hashing a
 * secret with a fast hash is what CodeQL rightly flags). Resolutions
 * (including "no key" and resolution failures) are memoized for
 * RESOLUTION_TTL_MS, so the hot market-data path pays no per-request DB
 * reads and a key save/delete takes effect within a few seconds. Idle
 * entries are swept so departed users' clients (and the credential strings
 * used for change detection) do not stay in memory. When Tradier itself
 * rejects a stored key (401/403 at request time), the credential is pinned
 * to the shared client until the user saves a different key — a revoked key
 * degrades market data to the shared token instead of failing every request.
 * Callers with no user context (capture cron, the shared index-quote poll in
 * StreamGateway) resolve to the shared client.
 */
@Injectable()
export class TradierClientResolver {
  /** How long a resolution (positive, negative, or failed) is trusted before
   *  the DB is re-read. Bounds a key save/delete to a few seconds of
   *  staleness while keeping the hot market-data path free of per-request DB
   *  reads — including when the DB or a stored blob is unhealthy. */
  private static readonly RESOLUTION_TTL_MS = 5_000;
  /** Entries idle longer than this are swept: the rebuild cost is one DB
   *  read, and sweeping drops departed users' clients and credentials. */
  private static readonly MAX_IDLE_MS = 60_000;

  private readonly logger = new Logger(TradierClientResolver.name);
  private readonly clients = new Map<string, ResolutionEntry>();
  private readonly shared: ResolvedTradier;
  private lastSweepAt = 0;

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
    this.sweep(now);
    const cached = this.clients.get(userId);
    if (cached && now - cached.refreshedAt < TradierClientResolver.RESOLUTION_TTL_MS) {
      return cached.resolved;
    }
    try {
      const secrets = await this.storedKeyFor(userId);
      if (!secrets) {
        this.clients.set(userId, { credential: null, resolved: this.shared, refreshedAt: now });
        return this.shared;
      }
      const credential = `${secrets.environment}:${secrets.apiKey}`;
      if (cached?.credential === credential) {
        cached.refreshedAt = now;
        return cached.resolved;
      }
      const baseUrl = this.baseUrlFor(secrets.environment);
      const resolved: ResolvedTradier = {
        client: this.watchForAuthFailure(this.factory(secrets.apiKey, baseUrl), userId, credential),
        // Opaque, never secret-derived: it keys shared caches and shows up
        // in log lines (e.g. options_analytics_stale_fallback).
        scope: `u-${randomUUID()}`,
      };
      this.clients.set(userId, { credential, resolved, refreshedAt: now });
      return resolved;
    } catch (err) {
      // A broken stored key (corrupt blob) or a DB read failure must degrade,
      // not take market data down for the user. Prefer the last-known-good
      // resolution, and memoize the outcome either way so an unhealthy DB is
      // not re-read on every request.
      this.logger.warn(
        `Falling back to the shared Tradier client: ${(err as Error).message ?? err}`,
      );
      const resolved = cached?.resolved ?? this.shared;
      this.clients.set(userId, {
        credential: cached?.credential ?? null,
        resolved,
        refreshedAt: now,
      });
      return resolved;
    }
  }

  /**
   * Probe a candidate key against Tradier before it is stored. Throws 400
   * INVALID_CREDENTIALS when the key is missing/blank and 400
   * TRADIER_KEY_INVALID when Tradier rejects the token (401/403); any other
   * failure (Tradier outage, network) does NOT block saving — the key may be
   * fine and can be verified on first use.
   */
  async verifyKey(apiKey: unknown, environment: TradingMode): Promise<void> {
    const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (trimmed === '') {
      throw errors.badRequest('INVALID_CREDENTIALS', 'apiKey is required');
    }
    const client = this.factory(trimmed, this.baseUrlFor(environment));
    try {
      await client.getExpirations('SPY');
    } catch (err) {
      if (TRADIER_AUTH_ERROR.test((err as Error).message ?? '')) {
        throw errors.badRequest(
          'TRADIER_KEY_INVALID',
          'Tradier rejected this API key — check that you copied the full token for the right environment',
        );
      }
    }
  }

  private baseUrlFor(environment: TradingMode): string {
    return environment === 'practice'
      ? TRADIER_SANDBOX_BASE_URL
      : this.config.get<string>('tradier.baseUrl') || 'https://api.tradier.com';
  }

  /**
   * Wrap a per-user client so a request-time 401/403 pins this credential to
   * the shared client (until the stored key changes): a key revoked after it
   * was saved degrades market data instead of failing every request forever.
   * The triggering request still surfaces its error.
   */
  private watchForAuthFailure(
    client: TradierClient,
    userId: string,
    credential: string,
  ): TradierClient {
    const pin = (err: unknown): void => {
      if (!TRADIER_AUTH_ERROR.test((err as Error).message ?? '')) return;
      const entry = this.clients.get(userId);
      if (entry?.credential !== credential) return; // key already changed
      this.logger.warn('Tradier rejected a stored per-user key; pinning user to the shared client');
      this.clients.set(userId, { credential, resolved: this.shared, refreshedAt: Date.now() });
    };
    return new Proxy(client, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const out = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (out instanceof Promise) {
            return out.catch((err: unknown) => {
              pin(err);
              throw err;
            });
          }
          return out;
        };
      },
    });
  }

  /** Drop entries idle past MAX_IDLE_MS so the map (and the credential
   *  strings inside it) tracks active users, not everyone ever seen. */
  private sweep(now: number): void {
    if (now - this.lastSweepAt < TradierClientResolver.MAX_IDLE_MS) return;
    this.lastSweepAt = now;
    for (const [userId, entry] of this.clients) {
      if (now - entry.refreshedAt > TradierClientResolver.MAX_IDLE_MS) this.clients.delete(userId);
    }
  }

  private async storedKeyFor(
    userId: string,
  ): Promise<{ apiKey: string; environment: TradingMode } | null> {
    // One parallel pair of queries; deliberately NOT getDecrypted per
    // environment, which would serialize up to 7 reads including the
    // legacy-Webull migration shim (that table can never hold Tradier rows).
    const [user, byEnvironment] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.credentials.getDecryptedProviderRows(userId, 'tradier'),
    ]);
    const mode: TradingMode = user?.tradingMode === 'practice' ? 'practice' : 'live';
    const environments: TradingMode[] = mode === 'practice' ? ['practice', 'live'] : ['live'];
    for (const environment of environments) {
      const stored = byEnvironment[environment];
      if (stored?.provider === 'tradier' && stored.apiKey) {
        return { apiKey: stored.apiKey, environment };
      }
    }
    return null;
  }
}
