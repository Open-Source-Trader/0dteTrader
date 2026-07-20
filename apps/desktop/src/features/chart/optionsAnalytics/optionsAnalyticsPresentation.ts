import type { OptionsAnalyticsSnapshot } from '@0dtetrader/shared-types';
import type { OptionsAnalyticsSettings } from './optionsAnalyticsSettings';
import { selectVisibleOptionsAnalyticsStrikes } from './optionsAnalyticsGeometry';

export interface OptionsAnalyticsLiquidityPresentation {
  callBidSize: number | null;
  callAskSize: number | null;
  putBidSize: number | null;
  putAskSize: number | null;
  callOpenInterest: number | null;
  putOpenInterest: number | null;
  callVolume: number | null;
  putVolume: number | null;
  callRelativeSpread: number | null;
  putRelativeSpread: number | null;
  callRoundTripCost: number | null;
  putRoundTripCost: number | null;
}

export interface OptionsAnalyticsStrikePresentation {
  strike: number;
  callImpliedVolatility: number | null;
  putImpliedVolatility: number | null;
  callDelta: number | null;
  putDelta: number | null;
  callDeltaNotional: number | null;
  putDeltaNotional: number | null;
  callGammaExposure: number;
  putGammaExposure: number;
  callScale: number;
  putScale: number;
  callDirection: 'right';
  putDirection: 'left';
  profileImportance: number;
  grossGammaExposure: number;
  totalOpenInterest: number;
  markedOiValue: number | null;
  callMarkedOiValue: number | null;
  putMarkedOiValue: number | null;
  callMarkedOiScale: number;
  putMarkedOiScale: number;
  liquidity: OptionsAnalyticsLiquidityPresentation | null;
  dealerProxyGammaExposure: number | null;
}

export interface OptionsAnalyticsPresentation {
  strikes: OptionsAnalyticsStrikePresentation[];
  allStrikes: OptionsAnalyticsStrikePresentation[];
  showGammaProfile: boolean;
  showMarkedOi: boolean;
  showLiquidity: boolean;
  profileStrikeCount: number;
  impliedRange: OptionsAnalyticsSnapshot['impliedRange'];
  callWall: number | null;
  putWall: number | null;
  dealerProxy: NonNullable<OptionsAnalyticsSnapshot['scenarios']['callPutDealerProxy']> | null;
  structureLine: string;
  qualityLines: string[];
  visibleQualityLines: string[];
  accessibleSummary: string;
}

function formatPrice(value: number): string {
  return value.toFixed(2);
}

export function formatCompactDollars(value: number): string {
  const absolute = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (absolute >= 1e9) return `${sign}$${(absolute / 1e9).toFixed(1)}B`;
  if (absolute >= 1e6) return `${sign}$${(absolute / 1e6).toFixed(1)}M`;
  if (absolute >= 1e3) return `${sign}$${(absolute / 1e3).toFixed(0)}K`;
  return `${sign}$${absolute.toFixed(0)}`;
}

function formatOptionalCompactDollars(value: number | null): string {
  return value === null ? 'unavailable' : formatCompactDollars(value);
}

function formatTimestamp(iso: string | null): string {
  if (iso === null) return 'unavailable';
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed)
    ? `${new Date(parsed).toISOString().slice(11, 19)} UTC`
    : 'unavailable';
}

function formatCurrentAge(nowMs: number, sourceAt: string | null): string {
  if (sourceAt === null) return 'unavailable';
  const source = Date.parse(sourceAt);
  if (!Number.isFinite(source)) return 'unavailable';
  return `${Math.max(0, Math.round((nowMs - source) / 1_000))}s`;
}

function sumNullable(first: number | null | undefined, second: number | null | undefined) {
  if (first === null || first === undefined) {
    return second === null || second === undefined ? null : second;
  }
  return first + (second ?? 0);
}

function withProfileImportance(
  strikes: OptionsAnalyticsStrikePresentation[],
  settings: OptionsAnalyticsSettings,
): OptionsAnalyticsStrikePresentation[] {
  const metrics: Array<(strike: OptionsAnalyticsStrikePresentation) => number> = [];
  if (settings.showGammaProfile) {
    metrics.push((strike) => Math.abs(strike.grossGammaExposure));
  }
  if (settings.showMarkedOi) {
    metrics.push((strike) => strike.markedOiValue ?? 0);
  }
  if (settings.showLiquidity) {
    metrics.push(
      (strike) =>
        (strike.liquidity?.callBidSize ?? 0) +
        (strike.liquidity?.callAskSize ?? 0) +
        (strike.liquidity?.putBidSize ?? 0) +
        (strike.liquidity?.putAskSize ?? 0),
      (strike) =>
        (strike.liquidity?.callOpenInterest ?? 0) + (strike.liquidity?.putOpenInterest ?? 0),
      (strike) => (strike.liquidity?.callVolume ?? 0) + (strike.liquidity?.putVolume ?? 0),
      (strike) =>
        Math.max(
          strike.liquidity?.callRelativeSpread ?? 0,
          strike.liquidity?.putRelativeSpread ?? 0,
        ),
      (strike) =>
        Math.max(strike.liquidity?.callRoundTripCost ?? 0, strike.liquidity?.putRoundTripCost ?? 0),
    );
  }

  const maxima = metrics.map((metric) => Math.max(0, ...strikes.map(metric)));
  return strikes.map((strike) => ({
    ...strike,
    profileImportance: Math.max(
      0,
      ...metrics.map((metric, index) => {
        const maximum = maxima[index] ?? 0;
        return maximum === 0 ? 0 : metric(strike) / maximum;
      }),
    ),
  }));
}

/** Uses the full point-in-time snapshot so viewport changes never resize retained OI bars. */
function withStableMarkedOiScale(
  strikes: OptionsAnalyticsStrikePresentation[],
): OptionsAnalyticsStrikePresentation[] {
  const maximumMarkedOi = Math.max(
    0,
    ...strikes.flatMap((strike) => [strike.callMarkedOiValue ?? 0, strike.putMarkedOiValue ?? 0]),
  );
  const scale = (value: number | null): number =>
    value === null || maximumMarkedOi === 0 ? 0 : Math.sqrt(value / maximumMarkedOi);
  return strikes.map((strike) => ({
    ...strike,
    callMarkedOiScale: scale(strike.callMarkedOiValue),
    putMarkedOiScale: scale(strike.putMarkedOiValue),
  }));
}

export function buildOptionsAnalyticsPresentation(
  snapshot: OptionsAnalyticsSnapshot,
  settings: OptionsAnalyticsSettings,
  nowMs: number = Date.now(),
): OptionsAnalyticsPresentation {
  const proxyByStrike = new Map(
    snapshot.scenarios.callPutDealerProxy?.strikeGammaExposures.map((entry) => [
      entry.strike,
      entry.gammaExposure,
    ]) ?? [],
  );
  const unscoredStrikes = snapshot.strikes.map<OptionsAnalyticsStrikePresentation>((strike) => {
    const callGammaExposure = strike.call?.gammaExposure ?? 0;
    const putGammaExposure = strike.put?.gammaExposure ?? 0;
    return {
      strike: strike.strike,
      callImpliedVolatility: strike.call?.impliedVolatility ?? null,
      putImpliedVolatility: strike.put?.impliedVolatility ?? null,
      callDelta: strike.call?.delta ?? null,
      putDelta: strike.put?.delta ?? null,
      callDeltaNotional: strike.call?.deltaNotional ?? null,
      putDeltaNotional: strike.put?.deltaNotional ?? null,
      callGammaExposure,
      putGammaExposure,
      callScale: 0,
      putScale: 0,
      callDirection: 'right',
      putDirection: 'left',
      profileImportance: 0,
      grossGammaExposure: strike.grossGammaExposure ?? 0,
      totalOpenInterest: strike.totalOpenInterest,
      markedOiValue: settings.showMarkedOi
        ? sumNullable(strike.call?.markedOiValue, strike.put?.markedOiValue)
        : null,
      callMarkedOiValue: settings.showMarkedOi ? (strike.call?.markedOiValue ?? null) : null,
      putMarkedOiValue: settings.showMarkedOi ? (strike.put?.markedOiValue ?? null) : null,
      callMarkedOiScale: 0,
      putMarkedOiScale: 0,
      liquidity: settings.showLiquidity
        ? {
            callBidSize: strike.call?.bidSize ?? null,
            callAskSize: strike.call?.askSize ?? null,
            putBidSize: strike.put?.bidSize ?? null,
            putAskSize: strike.put?.askSize ?? null,
            callOpenInterest: strike.call?.openInterest ?? null,
            putOpenInterest: strike.put?.openInterest ?? null,
            callVolume: strike.call?.volume ?? null,
            putVolume: strike.put?.volume ?? null,
            callRelativeSpread: strike.call?.relativeSpread ?? null,
            putRelativeSpread: strike.put?.relativeSpread ?? null,
            callRoundTripCost: strike.call?.roundTripCost ?? null,
            putRoundTripCost: strike.put?.roundTripCost ?? null,
          }
        : null,
      dealerProxyGammaExposure: settings.showDealerProxy
        ? (proxyByStrike.get(strike.strike) ?? null)
        : null,
    };
  });
  const allStrikes = withStableMarkedOiScale(withProfileImportance(unscoredStrikes, settings));
  const strikes = selectOptionsAnalyticsProfileStrikes(
    allStrikes,
    settings.profileStrikeCount,
    () => true,
  );

  const { scope, quality } = snapshot;
  const coveragePercent = Math.round(quality.coverage.ratio * 100);
  const warningLines =
    quality.warnings.length > 0
      ? quality.warnings.map((warning) => `Warning: ${warning}`)
      : ['Warnings none'];
  const provenanceLines = [
    `Expiration ${scope.expiration} · Root ${scope.rootSymbol} · Settlement ${scope.settlementStyle.toUpperCase()} · ${snapshot.exposureUnit}`,
    `Observed ${formatTimestamp(scope.observedAt)} (age ${formatCurrentAge(nowMs, scope.observedAt)}) · Quote ${formatTimestamp(quality.quoteAsOf)} (age ${formatCurrentAge(nowMs, quality.quoteAsOf)}) · Greeks ${formatTimestamp(quality.greeksAsOf)} (age ${formatCurrentAge(nowMs, quality.greeksAsOf)})`,
    `Feed ${quality.feedMode} · Coverage ${quality.coverage.contractsIncluded}/${quality.coverage.contractsTotal} (${coveragePercent}%) · Status ${quality.status} · Cache ${quality.cacheStatus}`,
    `Version ${quality.calculationVersion} · OI effective ${quality.oiEffectiveDate ?? 'unavailable'}`,
  ];
  const qualityLines = [...provenanceLines, ...warningLines];
  const visibleWarningLines =
    warningLines.length <= 3
      ? warningLines
      : [...warningLines.slice(0, 3), `${warningLines.length - 3} more warnings`];
  const visibleQualityLines = [...provenanceLines, ...visibleWarningLines];
  const structureLine = `Structure gamma C ${formatOptionalCompactDollars(snapshot.structure.callGammaExposure)} · P ${formatOptionalCompactDollars(snapshot.structure.putGammaExposure)} · gross ${formatOptionalCompactDollars(snapshot.structure.grossGammaExposure)} · delta notional C ${formatOptionalCompactDollars(snapshot.structure.callDeltaNotional)} · P ${formatOptionalCompactDollars(snapshot.structure.putDeltaNotional)}`;

  const summaryParts = [...qualityLines, structureLine];
  const impliedRange = settings.showImpliedRange ? snapshot.impliedRange : null;
  if (impliedRange) {
    summaryParts.push(
      `${impliedRange.label} ${formatPrice(impliedRange.lower)} to ${formatPrice(impliedRange.upper)}`,
      `straddle breakevens ${formatPrice(impliedRange.straddleLower)} to ${formatPrice(impliedRange.straddleUpper)}`,
    );
  }
  if (snapshot.structure.callWall !== null) {
    summaryParts.push(`call wall ${formatPrice(snapshot.structure.callWall)}`);
  }
  if (snapshot.structure.putWall !== null) {
    summaryParts.push(`put wall ${formatPrice(snapshot.structure.putWall)}`);
  }
  const dealerProxy = settings.showDealerProxy ? snapshot.scenarios.callPutDealerProxy : null;
  if (dealerProxy) {
    summaryParts.push(`dealer proxy assumption ${dealerProxy.assumption}`);
    summaryParts.push(
      `dealer proxy gamma exposure ${dealerProxy.gammaExposure.toFixed(2)}`,
      `dealer proxy delta notional ${dealerProxy.deltaNotional.toFixed(2)}`,
    );
    summaryParts.push(
      dealerProxy.gammaRoots.length > 0
        ? `dealer proxy roots ${dealerProxy.gammaRoots.map(formatPrice).join(', ')}`
        : 'dealer proxy roots unavailable',
    );
  }

  return {
    strikes,
    allStrikes,
    showGammaProfile: settings.showGammaProfile,
    showMarkedOi: settings.showMarkedOi,
    showLiquidity: settings.showLiquidity,
    profileStrikeCount: settings.profileStrikeCount,
    impliedRange,
    callWall: snapshot.structure.callWall,
    putWall: snapshot.structure.putWall,
    dealerProxy,
    structureLine,
    qualityLines,
    visibleQualityLines,
    accessibleSummary: summaryParts.join('. '),
  };
}

export function scaleOptionsAnalyticsStrikes(
  strikes: OptionsAnalyticsStrikePresentation[],
  normalizationStrikes: OptionsAnalyticsStrikePresentation[] = strikes,
): OptionsAnalyticsStrikePresentation[] {
  const maximumLegGamma = Math.max(
    0,
    ...normalizationStrikes.flatMap((strike) => [
      Math.abs(strike.callGammaExposure),
      Math.abs(strike.putGammaExposure),
    ]),
  );
  const scale = (value: number): number =>
    maximumLegGamma === 0 ? 0 : Math.sqrt(Math.abs(value) / maximumLegGamma);
  return strikes.map((strike) => ({
    ...strike,
    callScale: scale(strike.callGammaExposure),
    putScale: scale(strike.putGammaExposure),
  }));
}

export function selectOptionsAnalyticsProfileStrikes(
  allStrikes: OptionsAnalyticsStrikePresentation[],
  limit: number,
  isVisible: (strike: OptionsAnalyticsStrikePresentation) => boolean,
  score?: (strike: OptionsAnalyticsStrikePresentation) => number,
): OptionsAnalyticsStrikePresentation[] {
  return scaleOptionsAnalyticsStrikes(
    selectVisibleOptionsAnalyticsStrikes(
      allStrikes,
      limit,
      isVisible,
      score ?? ((strike) => strike.profileImportance),
    ),
    allStrikes,
  );
}
