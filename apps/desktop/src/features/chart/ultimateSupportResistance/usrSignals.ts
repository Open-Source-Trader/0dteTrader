import { USR } from './usrConstants';
import { confluenceCount } from './usrDerived';
import { fvgStrength } from './usrFvg';
import type { UsrRuntime } from './usrRuntime';
import type {
  UsrCandle,
  UsrFvg,
  UsrPool,
  UsrSignal,
  UsrSignalKind,
  UsrSignalSource,
  UsrZone,
} from './usrTypes';
import { isAbove, isBelow, zoneStrength } from './usrZones';

type SourceReference =
  | { kind: 'zone'; value: UsrZone }
  | { kind: 'pool'; value: UsrPool }
  | { kind: 'fvg' | 'ifvg'; value: UsrFvg };

interface Candidate {
  bullish: boolean;
  kind: UsrSignalKind;
  score: number;
  price: number;
  stop: number;
  source: UsrSignalSource;
  sourceKey: string;
  reference: SourceReference;
}

function consider(current: Candidate | null, candidate: Candidate): Candidate {
  return current === null || candidate.score > current.score ? candidate : current;
}

function resetQuota(
  runtime: UsrRuntime,
  source: {
    bounceSignalCount: number;
    sweepSignalCount: number;
    lastBounceSignalBar?: number;
    lastSweepSignalBar?: number;
    lastBounceSignalAnalysisBar?: number;
    lastSweepSignalAnalysisBar?: number;
  },
): void {
  const bounce = source.lastBounceSignalBar ?? source.lastBounceSignalAnalysisBar ?? 0;
  const sweep = source.lastSweepSignalBar ?? source.lastSweepSignalAnalysisBar ?? 0;
  if (bounce > 0 && runtime.analysisBarId - bounce > USR.signalCooldownBars)
    source.bounceSignalCount = 0;
  if (sweep > 0 && runtime.analysisBarId - sweep > USR.signalCooldownBars)
    source.sweepSignalCount = 0;
}

function lastSignal(source: SourceReference, kind: UsrSignalKind): number {
  if (source.kind === 'zone') {
    return kind === 'sweep' ? source.value.lastSweepSignalBar : source.value.lastBounceSignalBar;
  }
  return kind === 'sweep'
    ? source.value.lastSweepSignalAnalysisBar
    : source.value.lastBounceSignalAnalysisBar;
}

function quota(source: SourceReference, kind: UsrSignalKind): number {
  return kind === 'sweep' ? source.value.sweepSignalCount : source.value.bounceSignalCount;
}

function eligible(runtime: UsrRuntime, source: SourceReference, kind: UsrSignalKind): boolean {
  resetQuota(runtime, source.value);
  return (
    quota(source, kind) < USR.maximumSignalsPerSource &&
    lastSignal(source, kind) !== runtime.analysisBarId
  );
}

function makeCandidate(
  bullish: boolean,
  kind: UsrSignalKind,
  score: number,
  price: number,
  stop: number,
  reference: SourceReference,
): Candidate {
  return {
    bullish,
    kind,
    score: score + (kind === 'sweep' ? 0.1 : 0),
    price,
    stop,
    source: reference.kind,
    sourceKey: reference.kind === 'zone' ? String(reference.value.id) : reference.value.id,
    reference,
  };
}

function commit(runtime: UsrRuntime, candidate: Candidate, chartBarIndex: number): UsrSignal {
  const reference = candidate.reference;
  if (candidate.kind === 'sweep') {
    reference.value.sweepSignalCount += 1;
    if (reference.kind === 'zone') reference.value.lastSweepSignalBar = runtime.analysisBarId;
    else reference.value.lastSweepSignalAnalysisBar = runtime.analysisBarId;
  } else {
    reference.value.bounceSignalCount += 1;
    if (reference.kind === 'zone') reference.value.lastBounceSignalBar = runtime.analysisBarId;
    else reference.value.lastBounceSignalAnalysisBar = runtime.analysisBarId;
  }
  const signal: UsrSignal = {
    bullish: candidate.bullish,
    kind: candidate.kind,
    source: candidate.source,
    chartBarIndex,
    analysisBarId: runtime.analysisBarId,
    price: candidate.price,
    stop: candidate.stop,
    score: candidate.score,
    sourceKey: candidate.sourceKey,
  };
  runtime.signals.push(signal);
  return signal;
}

export function processUsrSignals(
  runtime: UsrRuntime,
  candles: readonly UsrCandle[],
  chartBarIndex: number,
  chartAtr: number,
): void {
  const settings = runtime.settings;
  if (
    (!settings.showBounceSignals && !settings.showSweepSignals) ||
    chartBarIndex < 1 ||
    runtime.analysisBarId < 0
  ) {
    return;
  }
  const setup = candles[chartBarIndex - 1];
  const confirmation = candles[chartBarIndex];
  const range = setup.high - setup.low;
  const bodyTop = Math.max(setup.open, setup.close);
  const bodyBottom = Math.min(setup.open, setup.close);
  const lowerWick = range > 0 ? ((bodyBottom - setup.low) / range) * 100 : 0;
  const upperWick = range > 0 ? ((setup.high - bodyTop) / range) * 100 : 0;
  const baselineValues = candles.slice(
    Math.max(0, chartBarIndex - 22),
    Math.max(0, chartBarIndex - 1),
  );
  const baseline =
    baselineValues.length === USR.signalVolumeSmaPeriod
      ? baselineValues.reduce((sum, candle) => sum + candle.volume, 0) / baselineValues.length
      : Math.max(setup.volume, 1);
  const highVolume = setup.volume > baseline;
  const qualification = settings.signalRequireQualification;
  const bullishQualified =
    !qualification || lowerWick >= USR.signalWickPercentThreshold || highVolume;
  const bearishQualified =
    !qualification || upperWick >= USR.signalWickPercentThreshold || highVolume;
  const bullishConfirmed =
    confirmation.low > setup.low &&
    confirmation.close > bodyTop &&
    (!settings.requireConfirmationCandleDirection || confirmation.close > confirmation.open);
  const bearishConfirmed =
    confirmation.high < setup.high &&
    confirmation.close < bodyBottom &&
    (!settings.requireConfirmationCandleDirection || confirmation.close < confirmation.open);
  const tolerance = chartAtr * 0.1;
  const epsilon = settings.minimumTick * settings.breakBufferTicks;
  let bullishBounce: Candidate | null = null;
  let bullishSweep: Candidate | null = null;
  let bearishBounce: Candidate | null = null;
  let bearishSweep: Candidate | null = null;

  if (bullishQualified && bullishConfirmed) {
    for (const zone of runtime.supportZones) {
      const age = runtime.analysisBarId - zone.analysisBirth;
      if (
        !zone.isActive ||
        age < USR.minimumZoneAge ||
        (zone.isFlipped && age < USR.signalMinimumAgeAfterFlip)
      )
        continue;
      const reference: SourceReference = { kind: 'zone', value: zone };
      const swept =
        isBelow(runtime, setup.low, zone.bottom) && isAbove(runtime, setup.close, zone.top);
      const bounced =
        !swept &&
        setup.low <= zone.top + tolerance &&
        setup.low >= zone.bottom - tolerance &&
        setup.close >= zone.top - epsilon;
      const score =
        zoneStrength(zone, runtime.analysisBarId) *
        (1 + 0.2 * (confluenceCount(runtime, zone) - 1));
      if (settings.showSweepSignals && swept && eligible(runtime, reference, 'sweep')) {
        bullishSweep = consider(
          bullishSweep,
          makeCandidate(true, 'sweep', score, zone.bottom, setup.low, reference),
        );
      } else if (settings.showBounceSignals && bounced && eligible(runtime, reference, 'bounce')) {
        bullishBounce = consider(
          bullishBounce,
          makeCandidate(true, 'bounce', score, zone.top, setup.low, reference),
        );
      }
    }
    if (settings.showLiquidityPools) {
      for (const pool of runtime.supportPools) {
        if (runtime.analysisBarId - pool.analysisBirth < USR.minimumZoneAge) continue;
        const reference: SourceReference = { kind: 'pool', value: pool };
        const swept =
          isBelow(runtime, setup.low, pool.bottom) && isAbove(runtime, setup.close, pool.top);
        const bounced =
          !swept &&
          setup.low <= pool.top + epsilon &&
          setup.low >= pool.bottom - epsilon &&
          setup.close >= pool.top - epsilon;
        if (settings.showSweepSignals && swept && eligible(runtime, reference, 'sweep')) {
          bullishSweep = consider(
            bullishSweep,
            makeCandidate(true, 'sweep', pool.strength, pool.bottom, setup.low, reference),
          );
        } else if (
          settings.showBounceSignals &&
          bounced &&
          eligible(runtime, reference, 'bounce')
        ) {
          bullishBounce = consider(
            bullishBounce,
            makeCandidate(true, 'bounce', pool.strength, pool.top, setup.low, reference),
          );
        }
      }
    }
    if (settings.showFvg) {
      const sources: Array<[UsrFvg, boolean]> = [
        ...runtime.bullishFvgs
          .filter((fvg) => fvg.isActive)
          .map((fvg): [UsrFvg, boolean] => [fvg, false]),
        ...runtime.bearishFvgs
          .filter((fvg) => fvg.ifvgActive)
          .map((fvg): [UsrFvg, boolean] => [fvg, true]),
      ];
      for (const [fvg, inverse] of sources) {
        const birth = inverse ? fvg.ifvgAnalysisBirth : fvg.analysisBirth;
        if (runtime.analysisBarId - birth < USR.minimumZoneAge) continue;
        const reference: SourceReference = { kind: inverse ? 'ifvg' : 'fvg', value: fvg };
        const swept =
          isBelow(runtime, setup.low, fvg.bottom) && isAbove(runtime, setup.close, fvg.top);
        const bounced =
          !swept &&
          setup.low <= fvg.top + epsilon &&
          setup.low >= fvg.bottom - epsilon &&
          setup.close >= fvg.top - epsilon;
        const score = fvgStrength(runtime, fvg, inverse);
        if (settings.showSweepSignals && swept && eligible(runtime, reference, 'sweep')) {
          bullishSweep = consider(
            bullishSweep,
            makeCandidate(true, 'sweep', score, fvg.bottom, setup.low, reference),
          );
        } else if (
          settings.showBounceSignals &&
          bounced &&
          eligible(runtime, reference, 'bounce')
        ) {
          bullishBounce = consider(
            bullishBounce,
            makeCandidate(true, 'bounce', score, fvg.top, setup.low, reference),
          );
        }
      }
    }
  }

  if (bearishQualified && bearishConfirmed) {
    for (const zone of runtime.resistanceZones) {
      const age = runtime.analysisBarId - zone.analysisBirth;
      if (
        !zone.isActive ||
        age < USR.minimumZoneAge ||
        (zone.isFlipped && age < USR.signalMinimumAgeAfterFlip)
      )
        continue;
      const reference: SourceReference = { kind: 'zone', value: zone };
      const swept =
        isAbove(runtime, setup.high, zone.top) && isBelow(runtime, setup.close, zone.bottom);
      const bounced =
        !swept &&
        setup.high >= zone.bottom - tolerance &&
        setup.high <= zone.top + tolerance &&
        setup.close <= zone.bottom + epsilon;
      const score =
        zoneStrength(zone, runtime.analysisBarId) *
        (1 + 0.2 * (confluenceCount(runtime, zone) - 1));
      if (settings.showSweepSignals && swept && eligible(runtime, reference, 'sweep')) {
        bearishSweep = consider(
          bearishSweep,
          makeCandidate(false, 'sweep', score, zone.top, setup.high, reference),
        );
      } else if (settings.showBounceSignals && bounced && eligible(runtime, reference, 'bounce')) {
        bearishBounce = consider(
          bearishBounce,
          makeCandidate(false, 'bounce', score, zone.bottom, setup.high, reference),
        );
      }
    }
    if (settings.showLiquidityPools) {
      for (const pool of runtime.resistancePools) {
        if (runtime.analysisBarId - pool.analysisBirth < USR.minimumZoneAge) continue;
        const reference: SourceReference = { kind: 'pool', value: pool };
        const swept =
          isAbove(runtime, setup.high, pool.top) && isBelow(runtime, setup.close, pool.bottom);
        const bounced =
          !swept &&
          setup.high >= pool.bottom - epsilon &&
          setup.high <= pool.top + epsilon &&
          setup.close <= pool.bottom + epsilon;
        if (settings.showSweepSignals && swept && eligible(runtime, reference, 'sweep')) {
          bearishSweep = consider(
            bearishSweep,
            makeCandidate(false, 'sweep', pool.strength, pool.top, setup.high, reference),
          );
        } else if (
          settings.showBounceSignals &&
          bounced &&
          eligible(runtime, reference, 'bounce')
        ) {
          bearishBounce = consider(
            bearishBounce,
            makeCandidate(false, 'bounce', pool.strength, pool.bottom, setup.high, reference),
          );
        }
      }
    }
    if (settings.showFvg) {
      const sources: Array<[UsrFvg, boolean]> = [
        ...runtime.bearishFvgs
          .filter((fvg) => fvg.isActive)
          .map((fvg): [UsrFvg, boolean] => [fvg, false]),
        ...runtime.bullishFvgs
          .filter((fvg) => fvg.ifvgActive)
          .map((fvg): [UsrFvg, boolean] => [fvg, true]),
      ];
      for (const [fvg, inverse] of sources) {
        const birth = inverse ? fvg.ifvgAnalysisBirth : fvg.analysisBirth;
        if (runtime.analysisBarId - birth < USR.minimumZoneAge) continue;
        const reference: SourceReference = { kind: inverse ? 'ifvg' : 'fvg', value: fvg };
        const swept =
          isAbove(runtime, setup.high, fvg.top) && isBelow(runtime, setup.close, fvg.bottom);
        const bounced =
          !swept &&
          setup.high >= fvg.bottom - epsilon &&
          setup.high <= fvg.top + epsilon &&
          setup.close <= fvg.bottom + epsilon;
        const score = fvgStrength(runtime, fvg, inverse);
        if (settings.showSweepSignals && swept && eligible(runtime, reference, 'sweep')) {
          bearishSweep = consider(
            bearishSweep,
            makeCandidate(false, 'sweep', score, fvg.top, setup.high, reference),
          );
        } else if (
          settings.showBounceSignals &&
          bounced &&
          eligible(runtime, reference, 'bounce')
        ) {
          bearishBounce = consider(
            bearishBounce,
            makeCandidate(false, 'bounce', score, fvg.bottom, setup.high, reference),
          );
        }
      }
    }
  }

  let bullish =
    bullishSweep && (!bullishBounce || bullishSweep.score >= bullishBounce.score)
      ? bullishSweep
      : bullishBounce;
  let bearish =
    bearishSweep && (!bearishBounce || bearishSweep.score >= bearishBounce.score)
      ? bearishSweep
      : bearishBounce;
  const conflictDistance = Math.max(
    chartAtr * USR.opposingSignalAtrMultiplier,
    Math.abs(confirmation.close) * USR.signalPriceMatchPercent,
  );
  if (
    settings.cancelOpposingSignal &&
    bullish &&
    runtime.previousBearSignal &&
    Math.abs(bullish.price - runtime.previousBearSignal.price) <= conflictDistance
  )
    bullish = null;
  if (
    settings.cancelOpposingSignal &&
    bearish &&
    runtime.previousBullSignal &&
    Math.abs(bearish.price - runtime.previousBullSignal.price) <= conflictDistance
  )
    bearish = null;
  if (bullish && bearish) {
    if (bullish.score > bearish.score) bearish = null;
    else if (bearish.score > bullish.score) bullish = null;
    else {
      bullish = null;
      bearish = null;
    }
  }
  runtime.previousBullSignal = bullish ? commit(runtime, bullish, chartBarIndex) : null;
  runtime.previousBearSignal = bearish ? commit(runtime, bearish, chartBarIndex) : null;
}
