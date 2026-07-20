import type { OptionsAnalyticsSnapshot } from '@0dtetrader/shared-types';

const SUPPORTED_EXPOSURE_UNIT: OptionsAnalyticsSnapshot['exposureUnit'] =
  '$ delta change per 1% underlying move';
const COVERAGE_RATIO_TOLERANCE = 1e-6;

type UnknownRecord = Record<string, unknown>;

function invalid(reason: string): never {
  throw new Error(`Invalid options analytics snapshot: ${reason}`);
}

function record(value: unknown, path: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(path);
  return value as UnknownRecord;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) invalid(path);
  return value;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(path);
  return value;
}

function positive(value: unknown, path: string): number {
  const parsed = finite(value, path);
  if (parsed <= 0) invalid(path);
  return parsed;
}

function nonNegative(value: unknown, path: string): number {
  const parsed = finite(value, path);
  if (parsed < 0) invalid(path);
  return parsed;
}

function nullableFinite(value: unknown, path: string): number | null {
  return value === null ? null : finite(value, path);
}

function nullablePositive(value: unknown, path: string): number | null {
  return value === null ? null : positive(value, path);
}

function nullableNonNegative(value: unknown, path: string): number | null {
  return value === null ? null : nonNegative(value, path);
}

function unitInterval(value: unknown, path: string): number {
  const parsed = finite(value, path);
  if (parsed < 0 || parsed > 1) invalid(path);
  return parsed;
}

function closedInterval(value: unknown, lower: number, upper: number, path: string): number {
  const parsed = finite(value, path);
  if (parsed < lower || parsed > upper) invalid(path);
  return parsed;
}

function nullableUnitInterval(value: unknown, path: string): number | null {
  return value === null ? null : unitInterval(value, path);
}

function nullableClosedInterval(
  value: unknown,
  lower: number,
  upper: number,
  path: string,
): number | null {
  return value === null ? null : closedInterval(value, lower, upper, path);
}

function calendarDate(value: unknown, path: string): string {
  const parsed = string(value, path);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parsed);
  if (!match) invalid(path);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) invalid(path);

  return parsed;
}

function isoTimestamp(value: unknown, path: string): string {
  const parsed = string(value, path);
  const dateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!dateTimePattern.test(parsed) || !Number.isFinite(Date.parse(parsed))) invalid(path);
  return parsed;
}

function nullableTimestamp(value: unknown, path: string): string | null {
  return value === null ? null : isoTimestamp(value, path);
}

function oneOf(value: unknown, supported: readonly string[], path: string): string {
  const parsed = string(value, path);
  if (!supported.includes(parsed)) invalid(path);
  return parsed;
}

function validateLeg(value: unknown, path: string): void {
  if (value === null) return;
  const leg = record(value, path);
  const modelFields = [
    leg.impliedVolatility,
    leg.delta,
    leg.gamma,
    leg.gammaExposure,
    leg.deltaNotional,
  ];
  if (
    !modelFields.every((field) => field === null) &&
    !modelFields.every((field) => field !== null)
  ) {
    invalid(`${path} local model fields must be all present or all null`);
  }
  nonNegative(leg.openInterest, `${path}.openInterest`);
  nonNegative(leg.volume, `${path}.volume`);
  nullablePositive(leg.impliedVolatility, `${path}.impliedVolatility`);
  nullableClosedInterval(leg.delta, -1, 1, `${path}.delta`);
  nullableNonNegative(leg.gamma, `${path}.gamma`);
  nullableNonNegative(leg.gammaExposure, `${path}.gammaExposure`);
  nullableFinite(leg.deltaNotional, `${path}.deltaNotional`);
  nullableNonNegative(leg.markedOiValue, `${path}.markedOiValue`);
  nullableNonNegative(leg.relativeSpread, `${path}.relativeSpread`);
  nullableNonNegative(leg.roundTripCost, `${path}.roundTripCost`);
  nonNegative(leg.bidSize, `${path}.bidSize`);
  nonNegative(leg.askSize, `${path}.askSize`);
  positive(leg.multiplier, `${path}.multiplier`);
}

/** Runtime contract gate for untrusted JSON before it reaches chart state. */
export function validateOptionsAnalyticsSnapshot(
  value: unknown,
  expectedSymbol: string,
  expectedExpiration: string,
): OptionsAnalyticsSnapshot {
  const snapshot = record(value, 'root');
  const scope = record(snapshot.scope, 'scope');
  const symbol = string(scope.symbol, 'scope.symbol');
  const rootSymbol = string(scope.rootSymbol, 'scope.rootSymbol');
  if (rootSymbol.trim().length === 0) invalid('scope.rootSymbol');
  const expiration = string(scope.expiration, 'scope.expiration');
  const settlementStyle = oneOf(scope.settlementStyle, ['am', 'pm'], 'scope.settlementStyle');
  const normalizedExpectedSymbol = expectedSymbol.toUpperCase().trim();
  if (symbol !== normalizedExpectedSymbol) invalid('scope.symbol');
  if (expiration !== expectedExpiration) invalid('scope.expiration');
  if (normalizedExpectedSymbol === 'SPX') {
    if (rootSymbol !== 'SPX' && rootSymbol !== 'SPXW') invalid('scope.rootSymbol');
    if (
      (rootSymbol === 'SPX' && settlementStyle !== 'am') ||
      (rootSymbol === 'SPXW' && settlementStyle !== 'pm')
    ) {
      invalid('scope.settlementStyle');
    }
  } else {
    if (rootSymbol !== normalizedExpectedSymbol) invalid('scope.rootSymbol');
    if (settlementStyle !== 'pm') invalid('scope.settlementStyle');
  }
  const observedAt = isoTimestamp(scope.observedAt, 'scope.observedAt');
  const settlementAt = isoTimestamp(scope.settlementAt, 'scope.settlementAt');
  if (Date.parse(observedAt) >= Date.parse(settlementAt)) invalid('scope settlement eligibility');
  positive(scope.spot, 'scope.spot');
  positive(scope.forward, 'scope.forward');
  if (snapshot.exposureUnit !== SUPPORTED_EXPOSURE_UNIT) invalid('exposureUnit');

  const quality = record(snapshot.quality, 'quality');
  nullableTimestamp(quality.quoteAsOf, 'quality.quoteAsOf');
  nullableTimestamp(quality.greeksAsOf, 'quality.greeksAsOf');
  if (quality.oiEffectiveDate !== null) {
    calendarDate(quality.oiEffectiveDate, 'quality.oiEffectiveDate');
  }
  oneOf(quality.feedMode, ['realtime', 'delayed', 'sandbox', 'unknown'], 'quality.feedMode');
  const coverage = record(quality.coverage, 'quality.coverage');
  const contractsTotal = nonNegative(coverage.contractsTotal, 'quality.coverage.contractsTotal');
  const contractsIncluded = nonNegative(
    coverage.contractsIncluded,
    'quality.coverage.contractsIncluded',
  );
  if (!Number.isInteger(contractsTotal) || !Number.isInteger(contractsIncluded)) {
    invalid('quality.coverage counts');
  }
  if (contractsIncluded > contractsTotal) invalid('quality.coverage counts');
  const ratio = unitInterval(coverage.ratio, 'quality.coverage.ratio');
  const expectedRatio = contractsTotal === 0 ? 0 : contractsIncluded / contractsTotal;
  if (Math.abs(ratio - expectedRatio) > COVERAGE_RATIO_TOLERANCE) {
    invalid('quality.coverage.ratio');
  }
  oneOf(quality.status, ['complete', 'partial'], 'quality.status');
  if (
    !Array.isArray(quality.warnings) ||
    quality.warnings.some((warning) => typeof warning !== 'string')
  ) {
    invalid('quality.warnings');
  }
  string(quality.calculationVersion, 'quality.calculationVersion');
  oneOf(quality.cacheStatus, ['fresh', 'memory-cache', 'stale-fallback'], 'quality.cacheStatus');

  const structure = record(snapshot.structure, 'structure');
  const callGammaExposure = nullableNonNegative(
    structure.callGammaExposure,
    'structure.callGammaExposure',
  );
  const putGammaExposure = nullableNonNegative(
    structure.putGammaExposure,
    'structure.putGammaExposure',
  );
  const grossGammaExposure = nullableNonNegative(
    structure.grossGammaExposure,
    'structure.grossGammaExposure',
  );
  const callDeltaNotional = nullableFinite(
    structure.callDeltaNotional,
    'structure.callDeltaNotional',
  );
  const putDeltaNotional = nullableFinite(structure.putDeltaNotional, 'structure.putDeltaNotional');
  if ((callGammaExposure === null) !== (callDeltaNotional === null)) {
    invalid('structure call model fields must be both present or both null');
  }
  if ((putGammaExposure === null) !== (putDeltaNotional === null)) {
    invalid('structure put model fields must be both present or both null');
  }
  const expectedGrossGamma = (callGammaExposure ?? 0) + (putGammaExposure ?? 0);
  if (callGammaExposure === null && putGammaExposure === null) {
    if (grossGammaExposure !== null) invalid('structure.grossGammaExposure');
  } else if (
    grossGammaExposure === null ||
    Math.abs(grossGammaExposure - expectedGrossGamma) >
      COVERAGE_RATIO_TOLERANCE * Math.max(1, Math.abs(expectedGrossGamma))
  ) {
    invalid('structure.grossGammaExposure');
  }
  nullablePositive(structure.callWall, 'structure.callWall');
  nullablePositive(structure.putWall, 'structure.putWall');
  nullableUnitInterval(structure.grossGammaConcentration, 'structure.grossGammaConcentration');
  nullablePositive(structure.maxOpenInterestStrike, 'structure.maxOpenInterestStrike');

  const scenarios = record(snapshot.scenarios, 'scenarios');
  let proxyStrikePrices: number[] | null = null;
  if (scenarios.callPutDealerProxy !== null) {
    const proxy = record(scenarios.callPutDealerProxy, 'scenarios.callPutDealerProxy');
    string(proxy.assumption, 'scenarios.callPutDealerProxy.assumption');
    finite(proxy.gammaExposure, 'scenarios.callPutDealerProxy.gammaExposure');
    finite(proxy.deltaNotional, 'scenarios.callPutDealerProxy.deltaNotional');
    if (!Array.isArray(proxy.strikeGammaExposures)) {
      invalid('scenarios.callPutDealerProxy.strikeGammaExposures');
    }
    let previousProxyStrike = -Infinity;
    proxyStrikePrices = proxy.strikeGammaExposures.map((entry, index) => {
      const value = record(entry, `scenarios.callPutDealerProxy.strikeGammaExposures.${index}`);
      const strike = positive(
        value.strike,
        `scenarios.callPutDealerProxy.strikeGammaExposures.${index}.strike`,
      );
      if (strike <= previousProxyStrike) {
        invalid('scenarios.callPutDealerProxy.strikeGammaExposures must be ascending and unique');
      }
      previousProxyStrike = strike;
      nullableFinite(
        value.gammaExposure,
        `scenarios.callPutDealerProxy.strikeGammaExposures.${index}.gammaExposure`,
      );
      return strike;
    });
    if (!Array.isArray(proxy.gammaRoots)) invalid('scenarios.callPutDealerProxy.gammaRoots');
    let previousRoot = -Infinity;
    const gammaRoots = proxy.gammaRoots.map((root, index) => {
      const parsed = positive(root, `scenarios.callPutDealerProxy.gammaRoots.${index}`);
      if (parsed <= previousRoot) {
        invalid('scenarios.callPutDealerProxy.gammaRoots must be ascending and unique');
      }
      previousRoot = parsed;
      return parsed;
    });
    const primaryGammaRoot = nullableFinite(
      proxy.primaryGammaRoot,
      'scenarios.callPutDealerProxy.primaryGammaRoot',
    );
    if (primaryGammaRoot !== null && !gammaRoots.includes(primaryGammaRoot)) {
      invalid('scenarios.callPutDealerProxy.primaryGammaRoot');
    }
  }

  if (snapshot.impliedRange !== null) {
    const range = record(snapshot.impliedRange, 'impliedRange');
    const lower = nonNegative(range.lower, 'impliedRange.lower');
    const upper = positive(range.upper, 'impliedRange.upper');
    if (lower > upper) invalid('impliedRange');
    if (range.confidence !== 0.68 || range.label !== 'model-implied 68% range') {
      invalid('impliedRange metadata');
    }
    positive(range.atmIv, 'impliedRange.atmIv');
    const straddleLower = nonNegative(range.straddleLower, 'impliedRange.straddleLower');
    const straddleUpper = positive(range.straddleUpper, 'impliedRange.straddleUpper');
    if (straddleLower > straddleUpper) invalid('impliedRange straddle');
  }

  if (!Array.isArray(snapshot.strikes)) invalid('strikes');
  let previousStrike = -Infinity;
  const factStrikePrices: number[] = [];
  snapshot.strikes.forEach((entry, index) => {
    const strike = record(entry, `strikes.${index}`);
    const strikePrice = positive(strike.strike, `strikes.${index}.strike`);
    if (strikePrice <= previousStrike) invalid('strikes must be ascending and unique');
    previousStrike = strikePrice;
    factStrikePrices.push(strikePrice);
    validateLeg(strike.call, `strikes.${index}.call`);
    validateLeg(strike.put, `strikes.${index}.put`);
    nullableNonNegative(strike.grossGammaExposure, `strikes.${index}.grossGammaExposure`);
    nonNegative(strike.totalOpenInterest, `strikes.${index}.totalOpenInterest`);
  });
  if (
    proxyStrikePrices !== null &&
    (proxyStrikePrices.length !== factStrikePrices.length ||
      proxyStrikePrices.some((strike, index) => strike !== factStrikePrices[index]))
  ) {
    invalid('scenarios.callPutDealerProxy.strikeGammaExposures must match fact strikes');
  }

  return snapshot as unknown as OptionsAnalyticsSnapshot;
}
