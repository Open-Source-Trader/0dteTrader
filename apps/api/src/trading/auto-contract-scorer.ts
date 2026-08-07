import type {
  AutoScoringCandidate,
  AutoScoringContributions,
  AutoScoringExclusion,
  AutoScoringExclusionReason,
  AutoScoringPreferences,
  AutoScoringRanking,
  AutoScoringResult,
  OptionType,
} from '@0dtetrader/shared-types';

const MAX_QUOTE_AGE_MS = 5_000;
const MAX_QUOTE_FUTURE_MS = 2_000;
const MAX_ANALYTICS_AGE_MS = 60_000;

export interface AutoScoringRequest {
  underlying: string;
  expiration: string;
  optionType: OptionType;
  spot: number;
}

export const CONSERVATIVE_AUTO_SCORING_PRESET: AutoScoringPreferences = {
  schemaVersion: 1,
  preset: 'conservative',
  targetAbsDelta: 0.25,
  strikeRungs: 5,
  maxSpreadBps: 500,
  maxPremiumDollars: 250,
  minOpenInterest: 100,
  gammaMode: 'avoid',
  weights: { delta: 0.3, spread: 0.25, openInterest: 0.2, gamma: 0.1, iv: 0.15 },
};

export const AGGRESSIVE_AUTO_SCORING_PRESET: AutoScoringPreferences = {
  schemaVersion: 1,
  preset: 'aggressive',
  targetAbsDelta: 0.4,
  strikeRungs: 8,
  maxSpreadBps: 1000,
  maxPremiumDollars: 500,
  minOpenInterest: 25,
  gammaMode: 'seek',
  weights: { delta: 0.25, spread: 0.15, openInterest: 0.15, gamma: 0.3, iv: 0.15 },
};

interface EligibleCandidate {
  candidate: AutoScoringCandidate;
  mid: number;
  spreadBps: number;
  premiumDollars: number;
  atmDistance: number;
  raw: AutoScoringContributions;
  normalized: AutoScoringContributions;
  weighted: AutoScoringContributions;
  score: number;
}

export function scoreAutoContracts(
  request: AutoScoringRequest,
  preferences: AutoScoringPreferences,
  inputCandidates: readonly AutoScoringCandidate[],
  serverTime: Date,
): AutoScoringResult {
  validateRequest(request, serverTime);
  validateAutoScoringPreferences(preferences);
  const nowMs = serverTime.getTime();
  const candidates = inputCandidates
    .map(sanitizeCandidate)
    .sort(
      (left, right) =>
        left.strike - right.strike ||
        left.expiration.localeCompare(right.expiration) ||
        left.optionType.localeCompare(right.optionType) ||
        left.symbol.localeCompare(right.symbol),
    );
  const strikeWindow = buildStrikeWindow(candidates, request, preferences.strikeRungs);
  const exclusions: AutoScoringExclusion[] = [];
  const eligible: EligibleCandidate[] = [];

  for (const candidate of candidates) {
    const reason = exclusionReason(candidate, request, preferences, strikeWindow, nowMs);
    if (reason) {
      exclusions.push({ symbol: candidate.symbol, reason });
      continue;
    }
    const bid = candidate.bid as number;
    const ask = candidate.ask as number;
    const mid = (bid + ask) / 2;
    const spreadBps = ((ask - bid) / mid) * 10_000;
    const premiumDollars = mid * 100;
    eligible.push({
      candidate,
      mid,
      spreadBps,
      premiumDollars,
      atmDistance: Math.abs(candidate.strike - request.spot),
      raw: { delta: 0, spread: 0, openInterest: 0, gamma: 0, iv: 0 },
      normalized: { delta: 0, spread: 0, openInterest: 0, gamma: 0, iv: 0 },
      weighted: { delta: 0, spread: 0, openInterest: 0, gamma: 0, iv: 0 },
      score: 0,
    });
  }

  if (eligible.length === 0) {
    return {
      rankings: [],
      exclusions,
      selectedSymbol: null,
      noPass: true,
      requiresConfirmation: true,
      rankedAt: serverTime.toISOString(),
    };
  }

  const ivMedian = median(eligible.map((item) => item.candidate.impliedVolatility as number));
  for (const item of eligible) {
    const candidate = item.candidate;
    item.raw = {
      delta: -Math.abs(Math.abs(candidate.delta as number) - preferences.targetAbsDelta),
      spread: -item.spreadBps,
      openInterest: candidate.openInterest as number,
      gamma:
        preferences.gammaMode === 'seek'
          ? Math.abs(candidate.gamma as number)
          : -Math.abs(candidate.gamma as number),
      iv: ivMedian - (candidate.impliedVolatility as number),
    };
  }

  const dimensions: Array<keyof AutoScoringContributions> = [
    'delta',
    'spread',
    'openInterest',
    'gamma',
    'iv',
  ];
  const totalWeight = dimensions.reduce((sum, key) => sum + preferences.weights[key], 0);
  for (const key of dimensions) {
    const values = eligible.map((item) => item.raw[key]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    for (const item of eligible) {
      item.normalized[key] = max === min ? 1 : (item.raw[key] - min) / (max - min);
      item.weighted[key] = item.normalized[key] * (preferences.weights[key] / totalWeight);
    }
  }
  for (const item of eligible) {
    item.score = dimensions.reduce((sum, key) => sum + item.weighted[key], 0);
  }
  eligible.sort(compareEligible);

  const rankings = eligible.map((item, index): AutoScoringRanking => ({
    rank: index + 1,
    candidate: item.candidate,
    score: item.score,
    rationale: {
      summary: summaryFor(item, index, eligible, exclusions, request, preferences),
      mid: item.mid,
      spreadBps: item.spreadBps,
      premiumDollars: item.premiumDollars,
      atmDistance: item.atmDistance,
      normalized: item.normalized,
      weighted: item.weighted,
    },
  }));
  return {
    rankings: rankings as [AutoScoringRanking, ...AutoScoringRanking[]],
    exclusions,
    selectedSymbol: rankings[0].candidate.symbol,
    noPass: false,
    requiresConfirmation: true,
    rankedAt: serverTime.toISOString(),
  };
}

export function validateAutoScoringPreferences(preferences: AutoScoringPreferences): void {
  if (preferences.schemaVersion !== 1) invalid('schemaVersion');
  if (!['conservative', 'aggressive', 'custom'].includes(preferences.preset)) invalid('preset');
  boundedNumber(preferences.targetAbsDelta, 0.01, 0.99, 'targetAbsDelta');
  boundedInteger(preferences.strikeRungs, 0, 20, 'strikeRungs');
  boundedNumber(preferences.maxSpreadBps, 0, 10_000, 'maxSpreadBps');
  boundedNumber(preferences.maxPremiumDollars, Number.MIN_VALUE, 1_000_000, 'maxPremiumDollars');
  boundedInteger(preferences.minOpenInterest, 0, 1_000_000_000, 'minOpenInterest');
  if (preferences.gammaMode !== 'seek' && preferences.gammaMode !== 'avoid') invalid('gammaMode');
  const values = Object.values(preferences.weights);
  if (
    values.length !== 5 ||
    values.some((weight) => !Number.isFinite(weight) || weight < 0 || weight > 1)
  ) {
    invalid('weights');
  }
  if (values.reduce((sum, weight) => sum + weight, 0) <= 0) invalid('weights');
}

function validateRequest(request: AutoScoringRequest, serverTime: Date): void {
  if (!request.underlying.trim()) invalid('underlying');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.expiration)) invalid('expiration');
  if (request.optionType !== 'call' && request.optionType !== 'put') invalid('optionType');
  if (!Number.isFinite(request.spot) || request.spot <= 0) invalid('spot');
  if (!Number.isFinite(serverTime.getTime())) throw new Error('Invalid server time.');
}

function buildStrikeWindow(
  candidates: readonly AutoScoringCandidate[],
  request: AutoScoringRequest,
  strikeRungs: number,
): Set<number> {
  const strikes = [
    ...new Set(
      candidates
        .filter(
          (candidate) =>
            candidate.expiration === request.expiration &&
            candidate.optionType === request.optionType,
        )
        .map((candidate) => candidate.strike)
        .filter(Number.isFinite),
    ),
  ].sort((left, right) => left - right);
  if (strikes.length === 0) return new Set();
  let anchorIndex = 0;
  for (let index = 1; index < strikes.length; index += 1) {
    const distance = Math.abs(strikes[index] - request.spot);
    const anchorDistance = Math.abs(strikes[anchorIndex] - request.spot);
    if (
      distance < anchorDistance ||
      (distance === anchorDistance &&
        (request.optionType === 'call'
          ? strikes[index] > strikes[anchorIndex]
          : strikes[index] < strikes[anchorIndex]))
    ) {
      anchorIndex = index;
    }
  }
  return new Set(
    strikes.slice(
      Math.max(0, anchorIndex - strikeRungs),
      Math.min(strikes.length, anchorIndex + strikeRungs + 1),
    ),
  );
}

function exclusionReason(
  candidate: AutoScoringCandidate,
  request: AutoScoringRequest,
  preferences: AutoScoringPreferences,
  strikeWindow: ReadonlySet<number>,
  nowMs: number,
): AutoScoringExclusionReason | null {
  if (candidate.expiration !== request.expiration) return 'wrong_expiration';
  if (candidate.optionType !== request.optionType) return 'wrong_option_type';
  if (!strikeWindow.has(candidate.strike)) return 'outside_strike_window';
  if (candidate.bid === null || candidate.ask === null || candidate.quoteTimestamp === null) {
    return 'missing_quote';
  }
  const bid = candidate.bid;
  const ask = candidate.ask;
  const quoteMs = Date.parse(candidate.quoteTimestamp);
  const mid = (bid + ask) / 2;
  if (
    !Number.isFinite(bid) ||
    !Number.isFinite(ask) ||
    bid < 0 ||
    ask <= 0 ||
    ask < bid ||
    !Number.isFinite(mid) ||
    mid <= 0 ||
    !Number.isFinite(quoteMs)
  ) {
    return 'invalid_quote';
  }
  if (quoteMs > nowMs + MAX_QUOTE_FUTURE_MS) return 'future_quote';
  if (nowMs - quoteMs > MAX_QUOTE_AGE_MS) return 'stale_quote';
  if (candidate.delta === null || !Number.isFinite(candidate.delta)) return 'missing_delta';
  if (candidate.gamma === null || !Number.isFinite(candidate.gamma)) return 'missing_gamma';
  if (
    candidate.impliedVolatility === null ||
    !Number.isFinite(candidate.impliedVolatility) ||
    candidate.impliedVolatility < 0
  ) {
    return 'missing_iv';
  }
  if (
    candidate.openInterest === null ||
    !Number.isInteger(candidate.openInterest) ||
    candidate.openInterest < 0
  ) {
    return 'missing_open_interest';
  }
  const analyticsMs = candidate.analyticsTimestamp
    ? Date.parse(candidate.analyticsTimestamp)
    : Number.NaN;
  if (
    !Number.isFinite(analyticsMs) ||
    nowMs - analyticsMs > MAX_ANALYTICS_AGE_MS ||
    analyticsMs > nowMs + MAX_QUOTE_FUTURE_MS
  ) {
    return 'stale_analytics';
  }
  if (Math.abs(candidate.delta) > 1) return 'delta_out_of_range';
  const spreadBps = ((ask - bid) / mid) * 10_000;
  if (spreadBps > preferences.maxSpreadBps) return 'spread_too_wide';
  if (mid * 100 > preferences.maxPremiumDollars) return 'premium_too_high';
  if (candidate.openInterest < preferences.minOpenInterest) return 'open_interest_too_low';
  return null;
}

function compareEligible(left: EligibleCandidate, right: EligibleCandidate): number {
  return (
    right.score - left.score ||
    left.spreadBps - right.spreadBps ||
    (right.candidate.openInterest as number) - (left.candidate.openInterest as number) ||
    left.atmDistance - right.atmDistance ||
    left.candidate.symbol.localeCompare(right.candidate.symbol)
  );
}

function summaryFor(
  item: EligibleCandidate,
  index: number,
  rankings: readonly EligibleCandidate[],
  exclusions: readonly AutoScoringExclusion[],
  request: AutoScoringRequest,
  preferences: AutoScoringPreferences,
): string {
  if (exclusions.length > 0 && rankings.every((entry) => entry.score === rankings[0].score)) {
    return item.atmDistance === 0
      ? 'Passes all hard filters at the ATM strike.'
      : 'Passes all hard filters within the strike window.';
  }
  if (rankings.length > 1 && rankings.every((entry) => entry.score === rankings[0].score)) {
    const first = rankings[0];
    const second = rankings[1];
    if (first.spreadBps !== second.spreadBps) {
      return index === 0
        ? 'Wins the score tie with the narrower spread.'
        : 'Loses the score tie on spread width.';
    }
    if (first.candidate.openInterest !== second.candidate.openInterest) {
      return index === 0
        ? 'Wins the score and spread tie with higher open interest.'
        : 'Loses the tie on open interest.';
    }
    if (first.atmDistance !== second.atmDistance) {
      return index === 0
        ? 'Wins the remaining tie by being closer to ATM.'
        : 'Loses the remaining tie on ATM distance.';
    }
    return index === 0
      ? 'Wins the final tie by contract symbol.'
      : 'Loses the final tie by contract symbol.';
  }
  if (preferences.gammaMode === 'seek' && request.optionType === 'put') {
    return index === 0
      ? 'Matches absolute put delta and seeks higher absolute gamma.'
      : 'Lower absolute delta fit and gamma than the winner.';
  }
  return item.normalized.delta === 1 && item.normalized.gamma === 1 && item.normalized.iv === 1
    ? 'Closest to target delta with lower gamma and IV.'
    : 'Narrower spread and higher open interest.';
}

function sanitizeCandidate(candidate: AutoScoringCandidate): AutoScoringCandidate {
  return {
    symbol: candidate.symbol,
    underlying: candidate.underlying,
    expiration: candidate.expiration,
    optionType: candidate.optionType,
    strike: candidate.strike,
    bid: candidate.bid,
    ask: candidate.ask,
    delta: candidate.delta,
    gamma: candidate.gamma,
    impliedVolatility: candidate.impliedVolatility,
    openInterest: candidate.openInterest,
    quoteProvider: candidate.quoteProvider,
    quoteTimestamp: candidate.quoteTimestamp,
    analyticsTimestamp: candidate.analyticsTimestamp,
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function boundedInteger(value: number, min: number, max: number, field: string): void {
  if (!Number.isInteger(value) || value < min || value > max) invalid(field);
}

function boundedNumber(value: number, min: number, max: number, field: string): void {
  if (!Number.isFinite(value) || value < min || value > max) invalid(field);
}

function invalid(field: string): never {
  throw new Error(`Invalid Auto scoring ${field}.`);
}
