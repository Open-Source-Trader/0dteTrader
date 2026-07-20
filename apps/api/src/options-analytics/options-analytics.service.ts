import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  OptionsAnalyticsCacheStatus,
  OptionsAnalyticsSnapshot,
} from '@0dtetrader/shared-types';
import {
  isEarlyCloseTradingDay,
  isTradingDay,
  optionSettlementAt,
} from '../broker/expiration-calendar';
import {
  computeOptionsAnalyticsSnapshot,
  type ValidatedAnalyticsContract,
} from './options-analytics.engine';
import { TradierClient, type TradierQuote } from './tradier.client';

/** Version 1 requires option quotes within one minute of the underlying quote. */
export const OPTIONS_ANALYTICS_MAX_INPUT_SKEW_MS_V1 = 60_000;

interface NormalizedSnapshotInput {
  symbol: string;
  rootSymbol: string;
  settlementStyle: 'am' | 'pm';
  expiration: string;
  observedAt: string;
  settlementAt: string;
  riskFreeRate: number;
  quote: TradierQuote;
  contractsTotal: number;
  contracts: ValidatedAnalyticsContract[];
  warnings: string[];
}

export interface OptionsAnalyticsSnapshotResult {
  snapshot: OptionsAnalyticsSnapshot;
  input: NormalizedSnapshotInput;
}

interface CacheEntry {
  storedAt: number;
  result: OptionsAnalyticsSnapshotResult;
}

interface ExpirationCacheEntry {
  storedAt: number;
  expirations: string[];
}

export interface OptionsAnalyticsServiceMetrics {
  requested: number;
  calculated: number;
  partial: number;
  failed: number;
  cacheHits: number;
  staleFallbacks: number;
}

function finiteConfig(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function newYorkDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

type MarketSessionPhase = 'closed-day' | 'premarket' | 'open' | 'postmarket';

function marketSessionPhase(now: Date): MarketSessionPhase {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  const day = new Date(Date.UTC(value('year'), value('month') - 1, value('day')));
  if (!isTradingDay(day)) return 'closed-day';
  const minutes = value('hour') * 60 + value('minute');
  const closeMinutes = isEarlyCloseTradingDay(day) ? 13 * 60 : 16 * 60;
  if (minutes < 9 * 60 + 30) return 'premarket';
  if (minutes < closeMinutes) return 'open';
  return 'postmarket';
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function earliestIso(left: string | null, right: string): string {
  if (left === null) return right;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

@Injectable()
export class OptionsAnalyticsService {
  private readonly logger = new Logger(OptionsAnalyticsService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<OptionsAnalyticsSnapshotResult>>();
  private readonly expirationCache = new Map<string, ExpirationCacheEntry>();
  private readonly expirationInFlight = new Map<string, Promise<string[]>>();

  readonly metrics: OptionsAnalyticsServiceMetrics = {
    requested: 0,
    calculated: 0,
    partial: 0,
    failed: 0,
    cacheHits: 0,
    staleFallbacks: 0,
  };

  constructor(
    private readonly config: ConfigService,
    private readonly tradier: TradierClient,
  ) {}

  get cacheEntryCount(): number {
    this.pruneExpiredCache(Date.now());
    return this.cache.size;
  }

  async getSnapshotResult(
    symbol: string,
    expiration?: string,
  ): Promise<OptionsAnalyticsSnapshotResult> {
    this.metrics.requested += 1;
    const normalizedSymbol = symbol.trim().toUpperCase();
    if (!/^[A-Z0-9.-]{1,12}$/.test(normalizedSymbol)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'A valid symbol is required (for example, SPY)',
      });
    }
    if (expiration !== undefined && !isCalendarDate(expiration)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'expiration must be YYYY-MM-DD',
      });
    }

    if (expiration) {
      const cached = this.freshCache(`${normalizedSymbol}:${expiration}`);
      if (cached) return cached;
    }
    let selected: string;
    try {
      const expirations = await this.getExpirations(normalizedSymbol);
      if (expiration) {
        if (!expirations.includes(expiration)) {
          throw new NotFoundException({
            code: 'EXPIRATION_NOT_FOUND',
            message: `No exact expiration ${expiration} is available for ${normalizedSymbol}`,
          });
        }
        selected = expiration;
      } else {
        const today = newYorkDate(new Date(Date.now()));
        selected = expirations.includes(today) ? today : expirations[0];
        if (!selected) {
          throw new NotFoundException({
            code: 'EXPIRATION_NOT_FOUND',
            message: `No option expirations are available for ${normalizedSymbol}`,
          });
        }
      }
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      const fallback = expiration ? this.staleCache(`${normalizedSymbol}:${expiration}`) : null;
      if (fallback) return fallback;
      return this.unavailable(normalizedSymbol, expiration, error);
    }

    const exactKey = `${normalizedSymbol}:${selected}`;
    const newlyCached = this.freshCache(exactKey);
    if (newlyCached) return newlyCached;
    const existing = this.inFlight.get(exactKey);
    if (existing) return existing;

    const calculation = this.calculateExact(normalizedSymbol, selected).finally(() => {
      this.inFlight.delete(exactKey);
    });
    this.inFlight.set(exactKey, calculation);
    return calculation;
  }

  async getSnapshot(symbol: string, expiration?: string): Promise<OptionsAnalyticsSnapshot> {
    return (await this.getSnapshotResult(symbol, expiration)).snapshot;
  }

  private async calculateExact(
    symbol: string,
    selected: string,
  ): Promise<OptionsAnalyticsSnapshotResult> {
    const exactKey = `${symbol}:${selected}`;

    try {
      const [quote, chain] = await Promise.all([
        this.tradier.getQuote(symbol),
        this.tradier.getChain(symbol, selected),
      ]);
      if (chain.contracts.length === 0) {
        throw new Error(`No validated contracts for ${symbol} ${selected}`);
      }
      const warnings = [...(quote.warnings ?? []), ...chain.warnings];
      let selectedRoot: string;
      let settlementStyle: 'am' | 'pm';
      let productContracts = chain.contracts;
      if (symbol === 'SPX') {
        const hasSpxw = chain.contracts.some((contract) => contract.rootSymbol === 'SPXW');
        selectedRoot = hasSpxw ? 'SPXW' : 'SPX';
        settlementStyle = selectedRoot === 'SPX' ? 'am' : 'pm';
        const excludedRoots = chain.contracts.filter(
          (contract) => contract.rootSymbol !== selectedRoot,
        );
        productContracts = chain.contracts.filter(
          (contract) => contract.rootSymbol === selectedRoot,
        );
        warnings.push(
          excludedRoots.length > 0
            ? `Selected ${selectedRoot} ${settlementStyle.toUpperCase()}-settled product; excluded ${excludedRoots.length} ${excludedRoots[0].rootSymbol} contracts from the same expiration`
            : `Selected ${selectedRoot} ${settlementStyle.toUpperCase()}-settled product for SPX`,
        );
      } else {
        selectedRoot = chain.contracts[0].rootSymbol;
        settlementStyle = 'pm';
        productContracts = chain.contracts.filter(
          (contract) => contract.rootSymbol === selectedRoot,
        );
      }

      const quoteTime = Date.parse(quote.quoteAsOf);
      if (!Number.isFinite(quoteTime)) {
        throw new Error(`Underlying quote timestamp is invalid for ${symbol}`);
      }
      // When the market is closed, the underlying's latest quote may be stamped
      // hours into after-hours trading while option quotes stop near the 4:15pm
      // ET close, so intraday skew between them is meaningless — the client has
      // already validated every timestamp against the completed session window.
      const closedSession = typeof quote.completedSessionDate === 'string';
      const outOfSyncContracts: string[] = [];
      const synchronizedContracts = productContracts.filter((contract) => {
        const contractTime = Date.parse(contract.quoteAsOf);
        const synchronized =
          Number.isFinite(contractTime) &&
          (closedSession ||
            Math.abs(contractTime - quoteTime) <= OPTIONS_ANALYTICS_MAX_INPUT_SKEW_MS_V1);
        if (!synchronized) {
          outOfSyncContracts.push(contract.symbol);
        }
        return synchronized;
      });
      if (outOfSyncContracts.length > 0) {
        warnings.push(
          `Excluded ${outOfSyncContracts.length} contracts whose option quote was out of sync with the underlying by more than ${OPTIONS_ANALYTICS_MAX_INPUT_SKEW_MS_V1}ms; samples: ${outOfSyncContracts.slice(0, 3).join(', ')}`,
        );
      }
      if (synchronizedContracts.length === 0) {
        throw new Error(
          `No option contracts are synchronized to the underlying quote for ${symbol}`,
        );
      }
      const selectedContractsTotal =
        chain.contractsTotalByRoot?.[selectedRoot] ?? chain.contractsTotal;
      const riskFreeRate = this.config.get<number>('optionsAnalytics.riskFreeRate');
      if (riskFreeRate === undefined) {
        throw new Error('optionsAnalytics.riskFreeRate is not configured');
      }
      const observedAt = new Date(Date.now());
      const settlementAt = optionSettlementAt(selected, symbol, selectedRoot);
      const snapshot = computeOptionsAnalyticsSnapshot({
        symbol,
        rootSymbol: selectedRoot,
        settlementStyle,
        expiration: selected,
        observedAt,
        settlementAt,
        spot: quote.spot,
        riskFreeRate,
        feedMode: quote.feedMode,
        contractsTotal: selectedContractsTotal,
        contracts: synchronizedContracts,
        warnings,
      });
      snapshot.quality.quoteAsOf = earliestIso(snapshot.quality.quoteAsOf, quote.quoteAsOf);
      const input: NormalizedSnapshotInput = {
        symbol,
        rootSymbol: selectedRoot,
        settlementStyle,
        expiration: selected,
        observedAt: observedAt.toISOString(),
        settlementAt: settlementAt.toISOString(),
        riskFreeRate,
        quote,
        contractsTotal: selectedContractsTotal,
        contracts: synchronizedContracts,
        warnings,
      };
      const result = { snapshot, input };
      this.storeCache(exactKey, result);
      this.metrics.calculated += 1;
      if (snapshot.quality.status === 'partial') this.metrics.partial += 1;
      this.logger.log(
        JSON.stringify({
          event: 'options_analytics_calculated',
          symbol,
          expiration: selected,
          rootSymbol: selectedRoot,
          settlementStyle,
          status: snapshot.quality.status,
          coverage: snapshot.quality.coverage,
          warnings: snapshot.quality.warnings,
          availableRequests: this.tradier.availableRequests,
          rateLimitExpiry: this.tradier.rateLimitExpiry,
        }),
      );
      return result;
    } catch (error) {
      const fallback = this.staleCache(exactKey);
      if (fallback) return fallback;
      return this.unavailable(symbol, selected, error);
    }
  }

  private freshCache(key: string): OptionsAnalyticsSnapshotResult | null {
    const now = Date.now();
    const entry = this.cache.get(key);
    if (!entry) return null;
    const hardTtl = this.cacheHardTtlMs;
    const age = now - entry.storedAt;
    if (age > hardTtl || !this.cacheSnapshotEligible(entry, now)) {
      this.cache.delete(key);
      return null;
    }
    if (age > this.cacheTtlMs) return null;
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.metrics.cacheHits += 1;
    return this.withCacheStatus(entry.result, 'memory-cache');
  }

  private staleCache(key: string): OptionsAnalyticsSnapshotResult | null {
    const now = Date.now();
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (now - entry.storedAt > this.cacheHardTtlMs) {
      this.cache.delete(key);
      return null;
    }
    if (!this.cacheSnapshotEligible(entry, now)) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.metrics.staleFallbacks += 1;
    this.logger.warn(JSON.stringify({ event: 'options_analytics_stale_fallback', key }));
    return this.withCacheStatus(entry.result, 'stale-fallback');
  }

  private withCacheStatus(
    result: OptionsAnalyticsSnapshotResult,
    cacheStatus: OptionsAnalyticsCacheStatus,
  ): OptionsAnalyticsSnapshotResult {
    return {
      input: result.input,
      snapshot: {
        ...result.snapshot,
        quality: { ...result.snapshot.quality, cacheStatus },
      },
    };
  }

  private cacheSnapshotEligible(entry: CacheEntry, now: number): boolean {
    const observedAt = new Date(entry.result.snapshot.scope.observedAt);
    const settlementAt = Date.parse(entry.result.snapshot.scope.settlementAt);
    const current = new Date(now);
    return (
      Number.isFinite(observedAt.getTime()) &&
      Number.isFinite(settlementAt) &&
      now < settlementAt &&
      newYorkDate(observedAt) === newYorkDate(current) &&
      marketSessionPhase(observedAt) === marketSessionPhase(current)
    );
  }

  private storeCache(key: string, result: OptionsAnalyticsSnapshotResult): void {
    this.cache.delete(key);
    this.cache.set(key, { storedAt: Date.now(), result });
    while (this.cache.size > this.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private pruneExpiredCache(now: number): void {
    for (const [key, entry] of this.cache) {
      if (now - entry.storedAt > this.cacheHardTtlMs) this.cache.delete(key);
    }
  }

  private get cacheTtlMs(): number {
    return Math.max(0, finiteConfig(this.config.get('optionsAnalytics.cacheTtlMs'), 15_000));
  }

  private get cacheHardTtlMs(): number {
    return Math.max(
      this.cacheTtlMs,
      finiteConfig(this.config.get('optionsAnalytics.cacheHardTtlMs'), 120_000),
    );
  }

  private get cacheMaxEntries(): number {
    return Math.max(
      1,
      Math.floor(finiteConfig(this.config.get('optionsAnalytics.cacheMaxEntries'), 128)),
    );
  }

  private async getExpirations(symbol: string): Promise<string[]> {
    const now = Date.now();
    const cached = this.expirationCache.get(symbol);
    if (cached && now - cached.storedAt <= this.expirationCacheTtlMs) {
      this.expirationCache.delete(symbol);
      this.expirationCache.set(symbol, cached);
      return cached.expirations;
    }
    if (cached) this.expirationCache.delete(symbol);
    const existing = this.expirationInFlight.get(symbol);
    if (existing) return existing;
    const request = this.tradier
      .getExpirations(symbol)
      .then((expirations) => {
        this.expirationCache.set(symbol, { storedAt: Date.now(), expirations });
        while (this.expirationCache.size > this.cacheMaxEntries) {
          const oldest = this.expirationCache.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.expirationCache.delete(oldest);
        }
        return expirations;
      })
      .finally(() => {
        this.expirationInFlight.delete(symbol);
      });
    this.expirationInFlight.set(symbol, request);
    return request;
  }

  private get expirationCacheTtlMs(): number {
    return Math.max(
      0,
      finiteConfig(this.config.get('optionsAnalytics.expirationCacheTtlMs'), 15 * 60_000),
    );
  }

  private unavailable(symbol: string, expiration: string | undefined, error: unknown): never {
    this.metrics.failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(
      JSON.stringify({
        event: 'options_analytics_failed',
        symbol,
        expiration,
        message,
      }),
    );
    throw new ServiceUnavailableException({
      code: 'OPTIONS_ANALYTICS_UNAVAILABLE',
      message: `Options analytics are unavailable for ${symbol}${expiration ? ` ${expiration}` : ''}`,
    });
  }
}
