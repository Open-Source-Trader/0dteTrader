import { Logger } from '@nestjs/common';
import type { Candle, OptionsAnalyticsFeedMode, Quote } from '@0dtetrader/shared-types';
import {
  isEarlyCloseTradingDay,
  isTradingDay,
  optionSettlementAt,
  previousTradingDay,
  ymd,
} from '../broker/expiration-calendar';
import type { ValidatedAnalyticsContract } from './options-analytics.engine';

const MAX_SOURCE_AGE_MS = 30 * 60_000;
const MAX_FUTURE_SKEW_MS = 2 * 60_000;
/** Provider Greeks are comparison-only and documented on an hourly cadence. */
const MAX_PROVIDER_GREEKS_AGE_MS = 2 * 60 * 60_000;
/** Version 1 quote-quality cutoff: (ask - bid) / midpoint may not exceed 100%. */
export const OPTIONS_ANALYTICS_MAX_RELATIVE_SPREAD_V1 = 1;
/** Version 1 never forms an NBBO midpoint from bid/ask timestamps over one minute apart. */
export const OPTIONS_ANALYTICS_MAX_BID_ASK_SKEW_MS_V1 = 60_000;

interface FetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type TradierFetch = (url: string, init: Record<string, unknown>) => Promise<FetchResponse>;

/** Tradier timesales start/end are Eastern local time, "YYYY-MM-DD HH:MM". */
function easternMinute(date: Date): string {
  // sv-SE formats as "YYYY-MM-DD HH:MM:SS" — trim the seconds.
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(date)
    .slice(0, 16);
}

export interface TradierQuote {
  symbol: string;
  spot: number;
  quoteAsOf: string;
  feedMode: OptionsAnalyticsFeedMode;
  warnings: string[];
}

export interface TradierChain {
  contractsTotal: number;
  contractsTotalByRoot: Record<string, number>;
  contracts: ValidatedAnalyticsContract[];
  warnings: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegative(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number >= 0 ? number : null;
}

function positive(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
}

function timestamp(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = Math.abs(value) < 1e12 ? value * 1_000 : value;
    const parsed = new Date(milliseconds);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const trimmed = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) return timestamp(numeric);
    }
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

function newYorkClock(now: Date): { day: Date; minutes: number } {
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
  return {
    day: new Date(Date.UTC(value('year'), value('month') - 1, value('day'))),
    minutes: value('hour') * 60 + value('minute'),
  };
}

interface SourceTimestampPolicy {
  latestCompletedSession: { date: string; close: Date } | null;
}

function sourceTimestampPolicy(now: Date): SourceTimestampPolicy {
  const marketClock = newYorkClock(now);
  const closeMinutes = isEarlyCloseTradingDay(marketClock.day) ? 13 * 60 : 16 * 60;
  const regularSessionOpen =
    isTradingDay(marketClock.day) &&
    marketClock.minutes >= 9 * 60 + 30 &&
    marketClock.minutes < closeMinutes;
  if (regularSessionOpen) return { latestCompletedSession: null };
  const completedDay =
    isTradingDay(marketClock.day) && marketClock.minutes >= closeMinutes
      ? marketClock.day
      : previousTradingDay(marketClock.day);
  const date = ymd(completedDay);
  return {
    latestCompletedSession: { date, close: optionSettlementAt(date, 'SPY', 'SPY') },
  };
}

function isUsableSourceTimestamp(
  value: Date,
  now: Date,
  policy: SourceTimestampPolicy,
  maximumAgeMs = MAX_SOURCE_AGE_MS,
): boolean {
  const completedSession = policy.latestCompletedSession;
  if (completedSession === null) return isFresh(value, now, maximumAgeMs);
  const ageAtClose = completedSession.close.getTime() - value.getTime();
  return ageAtClose >= -MAX_FUTURE_SKEW_MS && ageAtClose <= maximumAgeMs;
}

function closedSessionWarning(policy: SourceTimestampPolicy): string | null {
  const completedSession = policy.latestCompletedSession;
  if (completedSession === null) return null;
  return `Market is closed; using latest completed regular-session quotes from ${completedSession.date}; source timestamps and ages remain visible`;
}

function isFresh(value: Date, now: Date, maximumAgeMs = MAX_SOURCE_AGE_MS): boolean {
  const age = now.getTime() - value.getTime();
  return age <= maximumAgeMs && age >= -MAX_FUTURE_SKEW_MS;
}

class BoundedContractWarnings {
  private readonly reasons = new Map<string, { count: number; samples: string[] }>();

  add(reason: string, symbol: string): void {
    const group = this.reasons.get(reason) ?? { count: 0, samples: [] };
    group.count += 1;
    if (group.samples.length < 3 && !group.samples.includes(symbol)) group.samples.push(symbol);
    this.reasons.set(reason, group);
  }

  messages(): string[] {
    return [...this.reasons.entries()].map(
      ([reason, group]) =>
        `${reason} (${group.count} contract${group.count === 1 ? '' : 's'}; samples: ${group.samples.join(', ')})`,
    );
  }
}

export class TradierClient {
  private readonly logger = new Logger(TradierClient.name);
  private readonly fetchImpl: TradierFetch;

  availableRequests: number | null = null;
  rateLimitExpiry: string | null = null;
  private rateLimitResetAt: Date | null = null;

  constructor(
    private readonly token: string,
    private readonly baseUrl: string,
    fetchImpl?: TradierFetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.fetchImpl = fetchImpl ?? (globalThis.fetch as unknown as TradierFetch).bind(globalThis);
  }

  private async get(path: string): Promise<unknown> {
    if (!this.token) {
      throw new Error('Tradier is not configured: TRADIER_API_TOKEN is empty');
    }
    const requestNow = this.now();
    if (
      this.availableRequests !== null &&
      this.availableRequests <= 0 &&
      this.rateLimitResetAt !== null &&
      this.rateLimitResetAt.getTime() > requestNow.getTime()
    ) {
      throw new Error(`Tradier rate limit is exhausted until ${this.rateLimitExpiry}`);
    }
    const response = await this.fetchImpl(`${this.baseUrl}/v1${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });
    const available = response.headers.get('X-Ratelimit-Available');
    const parsedAvailable = available === null ? null : Number(available);
    this.availableRequests =
      parsedAvailable !== null && Number.isFinite(parsedAvailable) ? parsedAvailable : null;
    const rawExpiry = response.headers.get('X-Ratelimit-Expiry');
    const parsedExpiry = rawExpiry === null ? Number.NaN : Number(rawExpiry);
    if (
      rawExpiry !== null &&
      Number.isSafeInteger(parsedExpiry) &&
      parsedExpiry >= 1_000_000_000_000
    ) {
      const resetAt = new Date(parsedExpiry);
      this.rateLimitResetAt = resetAt;
      this.rateLimitExpiry = resetAt.toISOString();
    } else {
      this.rateLimitResetAt = null;
      this.rateLimitExpiry = null;
      if (rawExpiry !== null) {
        this.logger.warn(`Tradier rate-limit expiry header is invalid: ${rawExpiry}`);
      }
    }
    if (this.availableRequests !== null && this.availableRequests < 10) {
      this.logger.warn(
        `Tradier rate limit nearly exhausted: ${this.availableRequests} available; expiry=${this.rateLimitExpiry ?? 'unknown'}`,
      );
    }
    if (!response.ok) {
      throw new Error(`Tradier ${path} -> HTTP ${response.status}`);
    }
    return response.json();
  }

  async getExpirations(symbol: string): Promise<string[]> {
    const body = record(
      await this.get(`/markets/options/expirations?symbol=${encodeURIComponent(symbol)}`),
    );
    const expirations = record(body?.['expirations']);
    const rawDates = expirations?.['date'];
    const dates = Array.isArray(rawDates) ? rawDates : [rawDates];
    return [
      ...new Set(
        dates.filter(
          (date): date is string => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date),
        ),
      ),
    ].sort();
  }

  async getQuote(symbol: string): Promise<TradierQuote> {
    const body = record(await this.get(`/markets/quotes?symbols=${encodeURIComponent(symbol)}`));
    const quoteContainer = record(body?.['quotes']);
    const quoteValue = quoteContainer?.['quote'];
    const quote = record(Array.isArray(quoteValue) ? quoteValue[0] : quoteValue);
    const now = this.now();
    const timestampPolicy = sourceTimestampPolicy(now);
    const bid = positive(quote?.['bid']);
    const ask = positive(quote?.['ask']);
    const bidTime = timestamp(quote?.['bid_date']);
    const askTime = timestamp(quote?.['ask_date']);
    const validNbbo =
      bid !== null &&
      ask !== null &&
      ask >= bid &&
      bidTime !== null &&
      askTime !== null &&
      isUsableSourceTimestamp(bidTime, now, timestampPolicy) &&
      isUsableSourceTimestamp(askTime, now, timestampPolicy) &&
      Math.abs(bidTime.getTime() - askTime.getTime()) <= OPTIONS_ANALYTICS_MAX_BID_ASK_SKEW_MS_V1;
    const last = positive(quote?.['last']);
    const tradeTime = timestamp(quote?.['trade_date']);
    const validLast =
      last !== null &&
      tradeTime !== null &&
      isUsableSourceTimestamp(tradeTime, now, timestampPolicy);
    if (!validNbbo && !validLast) {
      throw new Error(`Tradier returned no finite, fresh timestamped spot for ${symbol}`);
    }
    const warnings: string[] = [];
    const sessionWarning = closedSessionWarning(timestampPolicy);
    if (sessionWarning !== null) warnings.push(sessionWarning);
    let spot: number;
    let quoteTime: Date;
    if (validNbbo) {
      spot = (bid! + ask!) / 2;
      quoteTime = bidTime!.getTime() <= askTime!.getTime() ? bidTime! : askTime!;
    } else {
      spot = last!;
      quoteTime = tradeTime!;
      warnings.push(
        'Underlying spot uses the fresh last trade because a valid fresh NBBO midpoint was unavailable',
      );
    }
    const feedMode: OptionsAnalyticsFeedMode = this.baseUrl.includes('sandbox')
      ? 'sandbox'
      : quote?.['delayed'] === true
        ? 'delayed'
        : quote?.['delayed'] === false
          ? 'realtime'
          : 'unknown';
    return {
      symbol,
      spot,
      quoteAsOf: quoteTime.toISOString(),
      feedMode,
      warnings,
    };
  }

  /**
   * Chart-quote parse for index symbols (SPX/NDX/VIX): tolerant where the
   * analytics getQuote above is strict. Indices often publish no NBBO and may
   * be delayed after hours — accept any finite price and default the rest to
   * 0 rather than throwing.
   */
  async getChartQuote(symbol: string): Promise<Quote> {
    const body = record(await this.get(`/markets/quotes?symbols=${encodeURIComponent(symbol)}`));
    const quoteContainer = record(body?.['quotes']);
    const quoteValue = quoteContainer?.['quote'];
    const quote = record(Array.isArray(quoteValue) ? quoteValue[0] : quoteValue);
    const bid = positive(quote?.['bid']);
    const ask = positive(quote?.['ask']);
    const last = finite(quote?.['last']);
    const price = last ?? (bid !== null && ask !== null && ask >= bid ? (bid + ask) / 2 : null);
    if (price === null) {
      throw new Error(`Tradier returned no finite price for ${symbol}`);
    }
    const time = timestamp(quote?.['trade_date']) ?? timestamp(quote?.['bid_date']) ?? this.now();
    return {
      symbol: symbol.toUpperCase(),
      bid: bid ?? 0,
      ask: ask ?? 0,
      last: price,
      bidSize: nonNegative(quote?.['bidsize']) ?? 0,
      askSize: nonNegative(quote?.['asksize']) ?? 0,
      volume: Math.round(nonNegative(quote?.['volume']) ?? 0),
      timestamp: time.toISOString(),
    };
  }

  /** Daily bars from /markets/history. Dates are stamped T00:00:00Z so the
   *  Monday-aligned weekly aggregation buckets them exactly. */
  async getDailyHistory(symbol: string, start: string, end: string): Promise<Candle[]> {
    const body = record(
      await this.get(
        `/markets/history?symbol=${encodeURIComponent(symbol)}&interval=daily&start=${start}&end=${end}`,
      ),
    );
    const history = record(body?.['history']);
    const rawDays = history?.['day'];
    const days = rawDays ? (Array.isArray(rawDays) ? rawDays : [rawDays]) : [];
    const candles: Candle[] = [];
    for (const value of days) {
      const day = record(value);
      const date = typeof day?.['date'] === 'string' ? day['date'] : null;
      const open = finite(day?.['open']);
      const high = finite(day?.['high']);
      const low = finite(day?.['low']);
      const close = finite(day?.['close']);
      if (!date || open === null || high === null || low === null || close === null) continue;
      candles.push({
        time: `${date}T00:00:00.000Z`,
        open,
        high,
        low,
        close,
        volume: Math.round(nonNegative(day?.['volume']) ?? 0),
      });
    }
    // Chart clients and aggregation both require ascending bars — do not
    // trust the provider's ordering.
    return candles.sort((a, b) => a.time.localeCompare(b.time));
  }

  /** Intraday bars from /markets/timesales (1min ~20 days back, 5/15min ~40). */
  async getTimeSales(
    symbol: string,
    interval: '1min' | '5min' | '15min',
    start: Date,
    end: Date,
  ): Promise<Candle[]> {
    const query =
      `symbol=${encodeURIComponent(symbol)}&interval=${interval}` +
      `&start=${encodeURIComponent(easternMinute(start))}&end=${encodeURIComponent(easternMinute(end))}`;
    const body = record(await this.get(`/markets/timesales?${query}`));
    const series = record(body?.['series']);
    const rawData = series?.['data'];
    const rows = rawData ? (Array.isArray(rawData) ? rawData : [rawData]) : [];
    const candles: Candle[] = [];
    for (const value of rows) {
      const row = record(value);
      // `timestamp` is epoch seconds — authoritative over the offset-less
      // Eastern `time` string.
      const epoch = finite(row?.['timestamp']);
      const open = finite(row?.['open']);
      const high = finite(row?.['high']);
      const low = finite(row?.['low']);
      const close = finite(row?.['close']);
      if (epoch === null || open === null || high === null || low === null || close === null) {
        continue;
      }
      candles.push({
        time: new Date(epoch * 1000).toISOString(),
        open,
        high,
        low,
        close,
        volume: Math.round(nonNegative(row?.['volume']) ?? 0),
      });
    }
    // Chart clients and aggregation both require ascending bars — do not
    // trust the provider's ordering.
    return candles.sort((a, b) => a.time.localeCompare(b.time));
  }

  async getChain(symbol: string, expiration: string): Promise<TradierChain> {
    const body = record(
      await this.get(
        `/markets/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${encodeURIComponent(expiration)}&greeks=true`,
      ),
    );
    const options = record(body?.['options']);
    const rawValue = options?.['option'];
    const rawOptions = rawValue ? (Array.isArray(rawValue) ? rawValue : [rawValue]) : [];
    const contractWarnings = new BoundedContractWarnings();
    const contracts: ValidatedAnalyticsContract[] = [];
    const contractsTotalByRoot: Record<string, number> = {};
    const now = this.now();
    const timestampPolicy = sourceTimestampPolicy(now);
    const normalizedSymbol = symbol.toUpperCase();

    for (const rawValue of rawOptions) {
      const raw = record(rawValue);
      const contractSymbol =
        typeof raw?.['symbol'] === 'string' ? raw['symbol'] : '(unknown contract)';
      const reject = (reason: string): void => {
        contractWarnings.add(`Excluded contracts: ${reason}`, contractSymbol);
      };
      if (!raw) {
        reject('provider contract is not an object');
        continue;
      }
      const rootSymbol =
        typeof raw['root_symbol'] === 'string' ? raw['root_symbol'].trim().toUpperCase() : '';
      if (rootSymbol !== '') {
        contractsTotalByRoot[rootSymbol] = (contractsTotalByRoot[rootSymbol] ?? 0) + 1;
      }
      if (
        rootSymbol === '' ||
        (normalizedSymbol === 'SPX'
          ? rootSymbol !== 'SPX' && rootSymbol !== 'SPXW'
          : rootSymbol !== normalizedSymbol)
      ) {
        reject(`root ${rootSymbol || '(missing)'} does not match ${normalizedSymbol}`);
        continue;
      }
      if (raw['expiration_date'] !== expiration) {
        reject(`expiration does not exactly match ${expiration}`);
        continue;
      }
      const optionType = raw['option_type'];
      if (optionType !== 'call' && optionType !== 'put') {
        reject('option type is missing or invalid');
        continue;
      }
      const strike = positive(raw['strike']);
      const openInterest = nonNegative(raw['open_interest']);
      const volume = nonNegative(raw['volume']);
      const bid = positive(raw['bid']);
      const ask = positive(raw['ask']);
      const bidSize = nonNegative(raw['bidsize']);
      const askSize = nonNegative(raw['asksize']);
      const multiplier = positive(raw['contract_size']);
      if (multiplier === null) {
        reject('contract multiplier is missing or invalid');
        continue;
      }
      if (
        strike === null ||
        openInterest === null ||
        volume === null ||
        bid === null ||
        ask === null ||
        bidSize === null ||
        askSize === null
      ) {
        reject('required finite quote, OI, volume, size, or strike field is missing');
        continue;
      }
      if (ask < bid) {
        reject('crossed two-sided market');
        continue;
      }
      const midpoint = (bid + ask) / 2;
      const relativeSpread = (ask - bid) / midpoint;
      if (
        !Number.isFinite(relativeSpread) ||
        relativeSpread > OPTIONS_ANALYTICS_MAX_RELATIVE_SPREAD_V1
      ) {
        reject(
          `two-sided market is too wide for v1 relative-spread limit ${OPTIONS_ANALYTICS_MAX_RELATIVE_SPREAD_V1}`,
        );
        continue;
      }
      const bidTime = timestamp(raw['bid_date']);
      const askTime = timestamp(raw['ask_date']);
      if (bidTime === null || askTime === null) {
        reject('quote timestamps are missing or invalid');
        continue;
      }
      if (
        Math.abs(bidTime.getTime() - askTime.getTime()) > OPTIONS_ANALYTICS_MAX_BID_ASK_SKEW_MS_V1
      ) {
        reject(
          `bid/ask timestamps differ by more than ${OPTIONS_ANALYTICS_MAX_BID_ASK_SKEW_MS_V1}ms`,
        );
        continue;
      }
      const quoteTime = bidTime.getTime() <= askTime.getTime() ? bidTime : askTime;
      if (!isUsableSourceTimestamp(quoteTime, now, timestampPolicy)) {
        reject('stale quote timestamp');
        continue;
      }
      const greeks = record(raw['greeks']);
      const providerGreeksTime = timestamp(greeks?.['updated_at']);
      const providerDeltaValue = finite(greeks?.['delta']);
      const providerGammaValue = nonNegative(greeks?.['gamma']);
      const providerIvValue = positive(greeks?.['mid_iv']);
      const validProviderGreeks =
        providerGreeksTime !== null &&
        isUsableSourceTimestamp(
          providerGreeksTime,
          now,
          timestampPolicy,
          MAX_PROVIDER_GREEKS_AGE_MS,
        ) &&
        providerDeltaValue !== null &&
        providerDeltaValue >= -1 &&
        providerDeltaValue <= 1 &&
        providerGammaValue !== null &&
        providerIvValue !== null;
      if (greeks === null) {
        contractWarnings.add('Provider Greek comparison data unavailable', contractSymbol);
      } else if (!validProviderGreeks) {
        contractWarnings.add(
          'Provider Greek comparison data stale or invalid and was nulled',
          contractSymbol,
        );
      }
      const lastValue = positive(raw['last']);
      const lastTradeTime = timestamp(raw['trade_date']);
      const validLast =
        lastValue !== null &&
        lastTradeTime !== null &&
        isUsableSourceTimestamp(lastTradeTime, now, timestampPolicy);
      if ((raw['last'] !== undefined || raw['trade_date'] !== undefined) && !validLast) {
        contractWarnings.add(
          'Provider comparison last trade stale or invalid and was nulled',
          contractSymbol,
        );
      }
      contracts.push({
        symbol: contractSymbol,
        strike,
        optionType,
        openInterest,
        volume,
        bid,
        ask,
        bidSize,
        askSize,
        multiplier,
        quoteAsOf: quoteTime.toISOString(),
        last: validLast ? lastValue : null,
        lastTradeAsOf: validLast ? lastTradeTime.toISOString() : null,
        providerDelta: validProviderGreeks ? providerDeltaValue : null,
        providerGamma: validProviderGreeks ? providerGammaValue : null,
        providerImpliedVolatility: validProviderGreeks ? providerIvValue : null,
        providerGreeksAsOf: validProviderGreeks ? providerGreeksTime.toISOString() : null,
        oiEffectiveDate: ymd(previousTradingDay(now)),
        rootSymbol,
      });
    }

    const warnings = contractWarnings.messages();
    const sessionWarning = contracts.length > 0 ? closedSessionWarning(timestampPolicy) : null;
    if (sessionWarning !== null) warnings.push(sessionWarning);
    if (rawOptions.length > 0) {
      warnings.push(
        `Open interest effective date inferred as ${ymd(previousTradingDay(now))}; Tradier does not publish an OI effective timestamp`,
      );
    }

    return {
      contractsTotal: rawOptions.length,
      contractsTotalByRoot,
      contracts,
      warnings,
    };
  }
}
