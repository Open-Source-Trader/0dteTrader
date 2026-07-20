import {
  OPTIONS_ANALYTICS_EXPOSURE_UNIT,
  type OptionsAnalyticsFeedMode,
  type OptionsAnalyticsSnapshot,
  type OptionsAnalyticsStrike,
  type OptionsAnalyticsStrikeLeg,
} from '@0dtetrader/shared-types';

export const OPTIONS_ANALYTICS_CALCULATION_VERSION = 'options-analytics-v1';

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1_000;
const SQRT_TWO_PI = Math.sqrt(2 * Math.PI);
const MIN_VOLATILITY = 0.0001;
const MAX_VOLATILITY = 5;
const ROOT_EPSILON = 1e-10;

export type AnalyticsOptionType = 'call' | 'put';

export interface ValidatedAnalyticsContract {
  symbol: string;
  strike: number;
  optionType: AnalyticsOptionType;
  openInterest: number;
  volume: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  multiplier: number;
  quoteAsOf: string;
  /** Provider last-trade comparison data; never used by the local model. */
  last: number | null;
  lastTradeAsOf: string | null;
  /** Provider Greek comparison data; never used by the local model. */
  providerDelta: number | null;
  providerGamma: number | null;
  providerImpliedVolatility: number | null;
  /** Provider Greek timestamp retained for diagnostics; local Greeks use quoteAsOf. */
  providerGreeksAsOf: string | null;
  oiEffectiveDate: string;
  rootSymbol: string;
}

export interface OptionsAnalyticsEngineInput {
  symbol: string;
  rootSymbol: string;
  settlementStyle: 'am' | 'pm';
  expiration: string;
  observedAt: Date;
  settlementAt: Date;
  spot: number;
  riskFreeRate: number;
  feedMode: OptionsAnalyticsFeedMode;
  contractsTotal: number;
  contracts: ValidatedAnalyticsContract[];
  warnings?: string[];
}

export interface BlackForwardResult {
  price: number;
  delta: number;
  gamma: number;
}

interface ModeledContract extends ValidatedAnalyticsContract {
  mid: number;
  impliedVolatility: number;
  delta: number;
  gamma: number;
  gammaExposure: number;
  deltaNotional: number;
}

interface UnmodeledContract extends ValidatedAnalyticsContract {
  mid: number;
  impliedVolatility: null;
  delta: null;
  gamma: null;
  gammaExposure: null;
  deltaNotional: null;
}

type AnalyzedContract = ModeledContract | UnmodeledContract;

function isModeledContract(contract: AnalyzedContract): contract is ModeledContract {
  return contract.impliedVolatility !== null;
}

function normalPdf(value: number): number {
  return Math.exp(-0.5 * value * value) / SQRT_TWO_PI;
}

function normalCdf(value: number): number {
  // Abramowitz and Stegun 7.1.26, with absolute error below 1.5e-7.
  const absolute = Math.abs(value);
  const t = 1 / (1 + 0.2316419 * absolute);
  const polynomial =
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const positive = 1 - normalPdf(absolute) * polynomial;
  return value >= 0 ? positive : 1 - positive;
}

function allFinite(values: number[]): boolean {
  return values.every(Number.isFinite);
}

/** One Black-Scholes-forward kernel used by IV, current Greeks, and scenarios. */
export function blackForwardKernel(
  optionType: AnalyticsOptionType,
  spot: number,
  forward: number,
  strike: number,
  timeYears: number,
  volatility: number,
  discountFactor = 1,
): BlackForwardResult {
  if (
    !allFinite([spot, forward, strike, timeYears, volatility, discountFactor]) ||
    spot <= 0 ||
    forward <= 0 ||
    strike <= 0 ||
    timeYears <= 0 ||
    volatility <= 0 ||
    discountFactor <= 0
  ) {
    throw new Error('Black forward inputs must be finite and strictly positive');
  }

  const rootTime = Math.sqrt(timeYears);
  const sigmaRootTime = volatility * rootTime;
  const d1 =
    (Math.log(forward / strike) + 0.5 * volatility * volatility * timeYears) / sigmaRootTime;
  const d2 = d1 - sigmaRootTime;
  const forwardRatio = forward / spot;
  const callPrice = discountFactor * (forward * normalCdf(d1) - strike * normalCdf(d2));
  const callDelta = discountFactor * forwardRatio * normalCdf(d1);
  const gamma = (discountFactor * forwardRatio * normalPdf(d1)) / (spot * sigmaRootTime);

  const result: BlackForwardResult =
    optionType === 'call'
      ? { price: callPrice, delta: callDelta, gamma }
      : {
          price: callPrice - discountFactor * (forward - strike),
          delta: callDelta - discountFactor * forwardRatio,
          gamma,
        };
  if (!allFinite([result.price, result.delta, result.gamma])) {
    throw new Error('Black forward calculation produced a non-finite value');
  }
  return result;
}

/** Local quote IV solved only from a valid target; no constant-IV fallback. */
export function solveImpliedVolatility(
  optionType: AnalyticsOptionType,
  targetPrice: number,
  spot: number,
  forward: number,
  strike: number,
  timeYears: number,
  discountFactor = 1,
): number | null {
  if (
    !allFinite([targetPrice, spot, forward, strike, timeYears, discountFactor]) ||
    targetPrice <= 0 ||
    spot <= 0 ||
    forward <= 0 ||
    strike <= 0 ||
    timeYears <= 0 ||
    discountFactor <= 0
  ) {
    return null;
  }

  const intrinsic =
    discountFactor * Math.max(optionType === 'call' ? forward - strike : strike - forward, 0);
  const upperBound = discountFactor * (optionType === 'call' ? forward : strike);
  if (targetPrice <= intrinsic || targetPrice >= upperBound) return null;

  const lowPrice = blackForwardKernel(
    optionType,
    spot,
    forward,
    strike,
    timeYears,
    MIN_VOLATILITY,
    discountFactor,
  ).price;
  const highPrice = blackForwardKernel(
    optionType,
    spot,
    forward,
    strike,
    timeYears,
    MAX_VOLATILITY,
    discountFactor,
  ).price;
  if (targetPrice < lowPrice || targetPrice > highPrice) return null;

  let lower = MIN_VOLATILITY;
  let upper = MAX_VOLATILITY;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const midpoint = (lower + upper) / 2;
    const price = blackForwardKernel(
      optionType,
      spot,
      forward,
      strike,
      timeYears,
      midpoint,
      discountFactor,
    ).price;
    if (Math.abs(price - targetPrice) <= 1e-9) return midpoint;
    if (price < targetPrice) lower = midpoint;
    else upper = midpoint;
  }
  const solved = (lower + upper) / 2;
  return Number.isFinite(solved) ? solved : null;
}

export interface ForwardPair {
  strike: number;
  callMid: number;
  putMid: number;
  callQuoteAsOf: string;
  putQuoteAsOf: string;
}

/** Median put-call-parity forward from quote pairs synchronized within a minute. */
export function impliedForwardFromPairs(pairs: ForwardPair[], discountFactor = 1): number | null {
  if (!Number.isFinite(discountFactor) || discountFactor <= 0) return null;
  const candidates = pairs
    .filter((pair) => {
      const callTime = Date.parse(pair.callQuoteAsOf);
      const putTime = Date.parse(pair.putQuoteAsOf);
      return (
        allFinite([pair.strike, pair.callMid, pair.putMid, callTime, putTime]) &&
        pair.strike > 0 &&
        pair.callMid >= 0 &&
        pair.putMid >= 0 &&
        Math.abs(callTime - putTime) <= 60_000
      );
    })
    .map((pair) => pair.strike + (pair.callMid - pair.putMid) / discountFactor)
    .filter((candidate) => Number.isFinite(candidate) && candidate > 0)
    .sort((left, right) => left - right);
  if (candidates.length === 0) return null;
  const middle = Math.floor(candidates.length / 2);
  return candidates.length % 2 === 1
    ? candidates[middle]
    : (candidates[middle - 1] + candidates[middle]) / 2;
}

export interface RootResult {
  roots: number[];
  primary: number | null;
}

/** Dense deterministic scan preserving exact zeros and every sign crossing. */
export function findRootsOnGrid(
  evaluate: (spot: number) => number,
  lower: number,
  upper: number,
  reference: number,
  intervals = 400,
): RootResult {
  if (
    !allFinite([lower, upper, reference, intervals]) ||
    lower <= 0 ||
    upper <= lower ||
    intervals < 1
  ) {
    return { roots: [], primary: null };
  }
  const count = Math.max(1, Math.floor(intervals));
  const step = (upper - lower) / count;
  const points = Array.from({ length: count + 1 }, (_, index) => {
    const spot = lower + index * step;
    return { spot, value: evaluate(spot) };
  });
  if (points.some((point) => !Number.isFinite(point.value))) {
    throw new Error('Gamma root evaluation produced a non-finite value');
  }
  if (points.every((point) => Math.abs(point.value) <= ROOT_EPSILON)) {
    return { roots: [], primary: null };
  }

  const roots: number[] = [];
  const addRoot = (root: number): void => {
    if (!Number.isFinite(root)) return;
    const tolerance = step * 1e-6;
    if (!roots.some((existing) => Math.abs(existing - root) <= tolerance)) {
      roots.push(root);
    }
  };
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    if (Math.abs(current.value) <= ROOT_EPSILON) addRoot(current.spot);
    if (index === 0) continue;
    const previous = points[index - 1];
    if (previous.value * current.value < 0) {
      let left = previous.spot;
      let leftValue = previous.value;
      let right = current.spot;
      let rightValue = current.value;
      while (right - left > 0.01) {
        const midpoint = (left + right) / 2;
        const midpointValue = evaluate(midpoint);
        if (!Number.isFinite(midpointValue)) {
          throw new Error('Gamma root evaluation produced a non-finite value');
        }
        if (Math.abs(midpointValue) <= ROOT_EPSILON) {
          left = midpoint;
          right = midpoint;
          break;
        }
        if (leftValue * midpointValue < 0) {
          right = midpoint;
          rightValue = midpointValue;
        } else {
          left = midpoint;
          leftValue = midpointValue;
        }
      }
      // Both endpoints still bracket the root; midpoint error is <= half the
      // final interval (at most one cent).
      void rightValue;
      addRoot((left + right) / 2);
    }
  }
  roots.sort((left, right) => left - right);
  const primary =
    roots.length === 0
      ? null
      : roots.reduce((nearest, root) =>
          Math.abs(root - reference) < Math.abs(nearest - reference) ? root : nearest,
        );
  return { roots, primary };
}

function midPrice(contract: ValidatedAnalyticsContract): number | null {
  if (
    !allFinite([contract.bid, contract.ask]) ||
    contract.bid <= 0 ||
    contract.ask <= 0 ||
    contract.ask < contract.bid
  ) {
    return null;
  }
  const mid = (contract.bid + contract.ask) / 2;
  return Number.isFinite(mid) && mid > 0 ? mid : null;
}

function relativeSpread(contract: ValidatedAnalyticsContract): number {
  const mid = midPrice(contract);
  if (mid === null) return Number.POSITIVE_INFINITY;
  const value = (contract.ask - contract.bid) / mid;
  return Number.isFinite(value) && value >= 0 ? value : Number.POSITIVE_INFINITY;
}

function compareDuplicateContracts(
  left: ValidatedAnalyticsContract,
  right: ValidatedAnalyticsContract,
): number {
  const spreadDifference = relativeSpread(left) - relativeSpread(right);
  if (spreadDifference !== 0) return spreadDifference;
  const parsedLeftTime = Date.parse(left.quoteAsOf);
  const parsedRightTime = Date.parse(right.quoteAsOf);
  const leftTime = Number.isFinite(parsedLeftTime) ? parsedLeftTime : Number.NEGATIVE_INFINITY;
  const rightTime = Number.isFinite(parsedRightTime) ? parsedRightTime : Number.NEGATIVE_INFINITY;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return left.symbol.localeCompare(right.symbol);
}

function earliestIso(values: string[]): string | null {
  const valid = values
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((left, right) => left.time - right.time);
  return valid[0]?.value ?? null;
}

function chooseWall(
  rows: OptionsAnalyticsStrike[],
  side: 'call' | 'put',
  spot: number,
): number | null {
  const candidates = rows.filter((row) => typeof row[side]?.gammaExposure === 'number');
  if (candidates.length === 0) return null;
  return candidates.reduce((best, row) => {
    const exposure = row[side]!.gammaExposure!;
    const bestExposure = best[side]!.gammaExposure!;
    if (exposure !== bestExposure) return exposure > bestExposure ? row : best;
    const distance = Math.abs(row.strike - spot);
    const bestDistance = Math.abs(best.strike - spot);
    if (distance !== bestDistance) return distance < bestDistance ? row : best;
    return row.strike < best.strike ? row : best;
  }).strike;
}

function finiteSnapshot(value: unknown, path = 'snapshot'): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} is not finite`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => finiteSnapshot(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => finiteSnapshot(item, `${path}.${key}`));
  }
}

/** Pure fact-first snapshot aggregation from validated, exact-expiration input. */
export function computeOptionsAnalyticsSnapshot(
  input: OptionsAnalyticsEngineInput,
): OptionsAnalyticsSnapshot {
  if (!Number.isFinite(input.spot) || input.spot <= 0) {
    throw new Error('A finite positive spot is required');
  }
  const timeMs = input.settlementAt.getTime() - input.observedAt.getTime();
  if (!Number.isFinite(timeMs) || timeMs <= 0) {
    throw new Error('Option chain is expired at or after settlement');
  }
  const timeYears = timeMs / MS_PER_YEAR;
  if (
    !Number.isFinite(input.riskFreeRate) ||
    input.riskFreeRate < -0.05 ||
    input.riskFreeRate > 0.25
  ) {
    throw new Error('Risk-free rate must be finite and between -5% and 25%');
  }
  const discountFactor = Math.exp(-input.riskFreeRate * timeYears);
  const warnings = [...(input.warnings ?? [])];
  warnings.push(
    `Discounting uses the configured annual risk-free rate ${(input.riskFreeRate * 100).toFixed(4)}%; it is not a live timestamped yield curve`,
  );

  const normalizedRoot = input.rootSymbol.trim().toUpperCase();
  const normalizedSymbol = input.symbol.trim().toUpperCase();
  if (
    normalizedRoot === '' ||
    input.contracts.some((contract) => contract.rootSymbol.trim().toUpperCase() !== normalizedRoot)
  ) {
    throw new Error('Mixed or mismatched option roots are not allowed in one analytics snapshot');
  }
  if (
    (normalizedSymbol === 'SPX' && normalizedRoot !== 'SPX' && normalizedRoot !== 'SPXW') ||
    (normalizedSymbol !== 'SPX' && normalizedRoot !== normalizedSymbol)
  ) {
    throw new Error(`Option root ${normalizedRoot} does not belong to ${normalizedSymbol}`);
  }
  const expectedSettlementStyle =
    normalizedSymbol === 'SPX' && normalizedRoot === 'SPX' ? 'am' : 'pm';
  if (input.settlementStyle !== expectedSettlementStyle) {
    throw new Error(
      `Settlement style ${input.settlementStyle} does not match selected root ${normalizedRoot}`,
    );
  }

  const duplicateGroups = new Map<string, ValidatedAnalyticsContract[]>();
  for (const contract of input.contracts) {
    const key = `${contract.strike}:${contract.optionType}`;
    const group = duplicateGroups.get(key) ?? [];
    group.push(contract);
    duplicateGroups.set(key, group);
  }
  const deduplicatedContracts: ValidatedAnalyticsContract[] = [];
  const ignoredDuplicates: string[] = [];
  for (const group of duplicateGroups.values()) {
    const ranked = [...group].sort(compareDuplicateContracts);
    const selected = ranked[0];
    deduplicatedContracts.push(selected);
    for (const ignored of ranked.slice(1)) {
      ignoredDuplicates.push(ignored.symbol);
    }
  }
  if (ignoredDuplicates.length > 0) {
    warnings.push(
      `Duplicate contracts ignored before all calculations: ${ignoredDuplicates.length}; samples: ${ignoredDuplicates.slice(0, 3).join(', ')}`,
    );
  }

  const groupedForForward = new Map<
    number,
    Partial<Record<AnalyticsOptionType, ValidatedAnalyticsContract>>
  >();
  for (const contract of deduplicatedContracts) {
    const group = groupedForForward.get(contract.strike) ?? {};
    group[contract.optionType] = contract;
    groupedForForward.set(contract.strike, group);
  }
  const forwardPairs: ForwardPair[] = [];
  for (const [strike, pair] of groupedForForward) {
    if (!pair.call || !pair.put) continue;
    const callMid = midPrice(pair.call);
    const putMid = midPrice(pair.put);
    if (callMid === null || putMid === null) continue;
    forwardPairs.push({
      strike,
      callMid,
      putMid,
      callQuoteAsOf: pair.call.quoteAsOf,
      putQuoteAsOf: pair.put.quoteAsOf,
    });
  }
  const forward = impliedForwardFromPairs(forwardPairs, discountFactor);
  if (forward === null) {
    throw new Error('No synchronized call/put quote pairs support an implied forward');
  }

  const quoteCandidates = deduplicatedContracts.map((contract) => {
    const mid = midPrice(contract);
    const localIv =
      mid === null
        ? null
        : solveImpliedVolatility(
            contract.optionType,
            mid,
            input.spot,
            forward,
            contract.strike,
            timeYears,
            discountFactor,
          );
    return { contract, mid, localIv };
  });

  const analyzed: AnalyzedContract[] = [];
  const unpriceableContracts: string[] = [];
  for (const { contract, mid, localIv } of quoteCandidates) {
    if (mid === null) {
      unpriceableContracts.push(contract.symbol);
      continue;
    }
    if (localIv === null) {
      unpriceableContracts.push(contract.symbol);
      analyzed.push({
        ...contract,
        mid,
        impliedVolatility: null,
        delta: null,
        gamma: null,
        gammaExposure: null,
        deltaNotional: null,
      });
      continue;
    }
    const impliedVolatility = localIv;
    const greeks = blackForwardKernel(
      contract.optionType,
      input.spot,
      forward,
      contract.strike,
      timeYears,
      impliedVolatility,
      discountFactor,
    );
    const gammaExposure =
      greeks.gamma * contract.openInterest * contract.multiplier * input.spot * input.spot * 0.01;
    const deltaNotional = greeks.delta * contract.openInterest * contract.multiplier * input.spot;
    analyzed.push({
      ...contract,
      mid: mid!,
      impliedVolatility,
      delta: greeks.delta,
      gamma: greeks.gamma,
      gammaExposure,
      deltaNotional,
    });
  }
  if (unpriceableContracts.length > 0) {
    warnings.push(
      `Local Greeks unavailable for ${unpriceableContracts.length} contracts because implied volatility could not be solved from each contract's own two-sided quote; observed OI and liquidity remain available where the quote is valid; samples: ${unpriceableContracts.slice(0, 3).join(', ')}`,
    );
  }
  const modeled = analyzed.filter(isModeledContract);

  const byStrike = new Map<number, Partial<Record<AnalyticsOptionType, AnalyzedContract>>>();
  for (const contract of analyzed) {
    const row = byStrike.get(contract.strike) ?? {};
    row[contract.optionType] = contract;
    byStrike.set(contract.strike, row);
  }

  const toLeg = (contract: AnalyzedContract | undefined): OptionsAnalyticsStrikeLeg | null => {
    if (!contract) return null;
    const spread = contract.ask - contract.bid;
    const markedOiValue = contract.mid * contract.openInterest * contract.multiplier;
    return {
      openInterest: contract.openInterest,
      volume: contract.volume,
      impliedVolatility: contract.impliedVolatility,
      delta: contract.delta,
      gamma: contract.gamma,
      gammaExposure: contract.gammaExposure,
      deltaNotional: contract.deltaNotional,
      markedOiValue: Number.isFinite(markedOiValue) ? markedOiValue : null,
      relativeSpread:
        contract.mid > 0 && Number.isFinite(spread / contract.mid) ? spread / contract.mid : null,
      roundTripCost: Number.isFinite(spread * contract.multiplier)
        ? spread * contract.multiplier
        : null,
      bidSize: contract.bidSize,
      askSize: contract.askSize,
      multiplier: contract.multiplier,
    };
  };

  const strikes = [...byStrike.entries()]
    .map(([strike, pair]): OptionsAnalyticsStrike => {
      const call = toLeg(pair.call);
      const put = toLeg(pair.put);
      const modeledGamma = [call?.gammaExposure, put?.gammaExposure].filter(
        (value): value is number => value !== null && value !== undefined,
      );
      return {
        strike,
        call,
        put,
        grossGammaExposure:
          modeledGamma.length === 0
            ? null
            : modeledGamma.reduce((sum, exposure) => sum + exposure, 0),
        totalOpenInterest: (call?.openInterest ?? 0) + (put?.openInterest ?? 0),
      };
    })
    .sort((left, right) => left.strike - right.strike);

  const modeledCalls = modeled.filter((contract) => contract.optionType === 'call');
  const modeledPuts = modeled.filter((contract) => contract.optionType === 'put');
  const callGammaExposure =
    modeledCalls.length === 0
      ? null
      : modeledCalls.reduce((sum, contract) => sum + contract.gammaExposure, 0);
  const putGammaExposure =
    modeledPuts.length === 0
      ? null
      : modeledPuts.reduce((sum, contract) => sum + contract.gammaExposure, 0);
  const grossGammaExposure =
    modeled.length === 0 ? null : (callGammaExposure ?? 0) + (putGammaExposure ?? 0);
  const callDeltaNotional =
    modeledCalls.length === 0
      ? null
      : modeledCalls.reduce((sum, contract) => sum + contract.deltaNotional, 0);
  const putDeltaNotional =
    modeledPuts.length === 0
      ? null
      : modeledPuts.reduce((sum, contract) => sum + contract.deltaNotional, 0);
  const modeledGrossRows = strikes
    .map((row) => row.grossGammaExposure)
    .filter((exposure): exposure is number => exposure !== null);
  const maxGross = modeledGrossRows.length > 0 ? Math.max(...modeledGrossRows) : null;
  const maxOiRow = strikes.reduce((best, row) => {
    if (row.totalOpenInterest !== best.totalOpenInterest) {
      return row.totalOpenInterest > best.totalOpenInterest ? row : best;
    }
    const distance = Math.abs(row.strike - input.spot);
    const bestDistance = Math.abs(best.strike - input.spot);
    if (distance !== bestDistance) return distance < bestDistance ? row : best;
    return row.strike < best.strike ? row : best;
  });

  const forwardRatio = forward / input.spot;
  const scenarioGammaAt = (candidateSpot: number): number => {
    const candidateForward = candidateSpot * forwardRatio;
    return modeled.reduce((sum, contract) => {
      const gamma = blackForwardKernel(
        contract.optionType,
        candidateSpot,
        candidateForward,
        contract.strike,
        timeYears,
        contract.impliedVolatility,
        discountFactor,
      ).gamma;
      const exposure =
        gamma * contract.openInterest * contract.multiplier * candidateSpot * candidateSpot * 0.01;
      return sum + (contract.optionType === 'call' ? exposure : -exposure);
    }, 0);
  };
  const lowerGrid = Math.max(0.01, Math.min(input.spot, strikes[0].strike) * 0.8);
  const upperGrid = Math.max(input.spot, strikes[strikes.length - 1].strike) * 1.2;
  const gammaRoots =
    modeled.length === 0
      ? { roots: [], primary: null }
      : findRootsOnGrid(scenarioGammaAt, lowerGrid, upperGrid, input.spot, 400);

  const pairedRows = strikes.filter(
    (row) =>
      typeof row.call?.impliedVolatility === 'number' &&
      typeof row.put?.impliedVolatility === 'number',
  );
  const atmRow = pairedRows.sort((left, right) => {
    const difference = Math.abs(left.strike - forward) - Math.abs(right.strike - forward);
    return difference || left.strike - right.strike;
  })[0];
  const impliedRange =
    atmRow?.call && atmRow.put
      ? (() => {
          const atmIv = (atmRow.call.impliedVolatility! + atmRow.put.impliedVolatility!) / 2;
          const totalVariance = atmIv * atmIv * timeYears;
          const rootVariance = Math.sqrt(totalVariance);
          const sourcePair = byStrike.get(atmRow.strike)!;
          const straddle = sourcePair.call!.mid + sourcePair.put!.mid;
          return {
            lower: forward * Math.exp(-totalVariance / 2 - rootVariance),
            upper: forward * Math.exp(-totalVariance / 2 + rootVariance),
            confidence: 0.68 as const,
            label: 'model-implied 68% range' as const,
            atmIv,
            straddleLower: Math.max(0, atmRow.strike - straddle),
            straddleUpper: atmRow.strike + straddle,
          };
        })()
      : null;
  if (impliedRange === null) {
    warnings.push('Implied range unavailable: no modeled call/put pair');
  }

  const contractsTotal = Math.max(input.contractsTotal, input.contracts.length);
  const contractsIncluded = modeled.length;
  const ratio = contractsTotal === 0 ? 0 : contractsIncluded / contractsTotal;
  if (contractsIncluded < contractsTotal) {
    warnings.push(`Analytics coverage is ${contractsIncluded} of ${contractsTotal} contracts`);
  }
  const deduplicatedWarnings = [...new Set(warnings)];
  const snapshot: OptionsAnalyticsSnapshot = {
    scope: {
      symbol: input.symbol,
      rootSymbol: normalizedRoot,
      settlementStyle: input.settlementStyle,
      expiration: input.expiration,
      observedAt: input.observedAt.toISOString(),
      settlementAt: input.settlementAt.toISOString(),
      spot: input.spot,
      forward,
    },
    exposureUnit: OPTIONS_ANALYTICS_EXPOSURE_UNIT,
    quality: {
      quoteAsOf: earliestIso(analyzed.map((contract) => contract.quoteAsOf)),
      // Version 1 Greeks are derived locally from quote IV, so their source
      // freshness is the conservative oldest included quote timestamp.
      greeksAsOf: earliestIso(modeled.map((contract) => contract.quoteAsOf)),
      oiEffectiveDate: analyzed.map((contract) => contract.oiEffectiveDate).sort()[0] ?? null,
      feedMode: input.feedMode,
      coverage: { contractsTotal, contractsIncluded, ratio },
      // Informational provenance/assumption warnings do not make complete
      // modeled layers partial. Coverage and required derived layers do.
      status:
        contractsIncluded === contractsTotal && impliedRange !== null ? 'complete' : 'partial',
      warnings: deduplicatedWarnings,
      calculationVersion: OPTIONS_ANALYTICS_CALCULATION_VERSION,
      cacheStatus: 'fresh',
    },
    structure: {
      callGammaExposure,
      putGammaExposure,
      grossGammaExposure,
      callDeltaNotional,
      putDeltaNotional,
      callWall: chooseWall(strikes, 'call', input.spot),
      putWall: chooseWall(strikes, 'put', input.spot),
      grossGammaConcentration:
        grossGammaExposure !== null && grossGammaExposure > 0 && maxGross !== null
          ? maxGross / grossGammaExposure
          : null,
      maxOpenInterestStrike: maxOiRow.totalOpenInterest > 0 ? maxOiRow.strike : null,
    },
    scenarios: {
      callPutDealerProxy:
        modeled.length === 0
          ? null
          : {
              assumption:
                'Call gamma is positive and put gamma is negative; delta uses model-signed call and put delta. Open interest does not reveal actual dealer inventory.',
              gammaExposure: (callGammaExposure ?? 0) - (putGammaExposure ?? 0),
              deltaNotional: (callDeltaNotional ?? 0) + (putDeltaNotional ?? 0),
              strikeGammaExposures: strikes.map((row) => ({
                strike: row.strike,
                gammaExposure:
                  (row.call?.gammaExposure ?? null) === null &&
                  (row.put?.gammaExposure ?? null) === null
                    ? null
                    : (row.call?.gammaExposure ?? 0) - (row.put?.gammaExposure ?? 0),
              })),
              gammaRoots: gammaRoots.roots,
              primaryGammaRoot: gammaRoots.primary,
            },
    },
    impliedRange,
    strikes,
  };
  finiteSnapshot(snapshot);
  return snapshot;
}
