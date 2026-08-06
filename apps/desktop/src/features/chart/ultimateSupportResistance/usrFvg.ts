import { USR } from './usrConstants';
import { clamp, quantizedPriceKey } from './usrMath';
import type { UsrRuntime } from './usrRuntime';
import type { UsrFvg, UsrFvgDirection } from './usrTypes';
import { activeAnalysisAtr, isAbove, isBelow } from './usrZones';

function visibleCount(owner: readonly UsrFvg[]): number {
  return owner.reduce((count, fvg) => count + Number(fvg.visualVisible), 0);
}

/** Pine deletes drawings from the oldest retained record toward the newest. */
function enforceVisualCap(runtime: UsrRuntime, owner: UsrFvg[]): void {
  let count = visibleCount(owner);
  for (
    let index = owner.length - 1;
    count > runtime.settings.maxVisibleFvgs && index >= 0;
    index -= 1
  ) {
    if (!owner[index].visualVisible) continue;
    owner[index].visualVisible = false;
    count -= 1;
  }
}

function reserveVisualSlot(runtime: UsrRuntime, owner: UsrFvg[]): void {
  let count = visibleCount(owner);
  for (
    let index = owner.length - 1;
    count >= runtime.settings.maxVisibleFvgs && index >= 0;
    index -= 1
  ) {
    if (!owner[index].visualVisible) continue;
    owner[index].visualVisible = false;
    count -= 1;
  }
}

function fvgId(
  runtime: UsrRuntime,
  direction: UsrFvgDirection,
  startBar: number,
  top: number,
  bottom: number,
): string {
  const tick = runtime.settings.minimumTick;
  return `${direction === 'bullish' ? 'FB' : 'FR'}:${runtime.timeframeTag}:${startBar}:${quantizedPriceKey(top, tick)}:${quantizedPriceKey(bottom, tick)}`;
}

function createFvg(
  runtime: UsrRuntime,
  direction: UsrFvgDirection,
  top: number,
  bottom: number,
  startBar: number,
): void {
  const atr = activeAnalysisAtr(runtime, runtime.analysis[runtime.analysisBarId]);
  const minimum = Math.max(runtime.settings.minimumTick * 2, atr * runtime.settings.fvgMinGapAtr);
  if (!(top >= bottom) || top - bottom < minimum) return;
  const owner = direction === 'bullish' ? runtime.bullishFvgs : runtime.bearishFvgs;
  const id = fvgId(runtime, direction, startBar, top, bottom);
  if (owner.some((fvg) => fvg.id === id)) return;
  const fvg: UsrFvg = {
    id,
    visualVisible: true,
    top,
    bottom,
    ce: (top + bottom) / 2,
    startBar,
    analysisBirth: runtime.analysisBarId,
    ifvgAnalysisBirth: 0,
    endBar: 0,
    ifvgEndBar: 0,
    direction,
    isActive: true,
    lifecycle: 'untouched',
    milestoneReached: false,
    ifvgActive: false,
    bounceSignalCount: 0,
    sweepSignalCount: 0,
    lastBounceSignalAnalysisBar: 0,
    lastSweepSignalAnalysisBar: 0,
  };
  owner.unshift(fvg);
  enforceVisualCap(runtime, owner);
  if (owner.length > USR.maximumStoredFvgsPerSide) owner.length = USR.maximumStoredFvgsPerSide;
}

function detect(runtime: UsrRuntime): void {
  const index = runtime.analysisBarId;
  if (index < 2) return;
  const first = runtime.analysis[index - 2];
  const displacement = runtime.analysis[index - 1];
  const third = runtime.analysis[index];
  const displacementIndex = index - 1;
  const lookback = runtime.settings.fvgLookback;
  if (displacementIndex < lookback) return;
  let laggedBodyTotal = 0;
  for (
    let bodyIndex = displacementIndex - lookback;
    bodyIndex < displacementIndex;
    bodyIndex += 1
  ) {
    const candle = runtime.analysis[bodyIndex];
    laggedBodyTotal += Math.abs(candle.close - candle.open);
  }
  const body = Math.abs(displacement.close - displacement.open);
  const average = laggedBodyTotal / lookback;
  const wickTolerance = body * runtime.settings.fvgWickPercent;
  const displacementAtr =
    runtime.timeframeTag === 'chart' ? activeAnalysisAtr(runtime, displacement) : displacement.atr;
  const enoughBody =
    body >= average * runtime.settings.fvgBodyPercent &&
    displacementAtr !== null &&
    body >= displacementAtr * runtime.settings.fvgMinBodyAtr;
  const upward =
    enoughBody &&
    displacement.close > displacement.open &&
    displacement.high - displacement.close <= wickTolerance &&
    displacement.open - displacement.low <= wickTolerance;
  const downward =
    enoughBody &&
    displacement.close < displacement.open &&
    displacement.close - displacement.low <= wickTolerance &&
    displacement.high - displacement.open <= wickTolerance;
  if (upward && third.low > first.high) {
    createFvg(runtime, 'bullish', third.low, first.high, first.chartStartIndex);
  }
  if (downward && third.high < first.low) {
    createFvg(runtime, 'bearish', first.low, third.high, first.chartStartIndex);
  }
}

function activateInverse(runtime: UsrRuntime, owner: UsrFvg[], fvg: UsrFvg): void {
  if (!runtime.settings.showIfvg || fvg.ifvgActive) return;
  // One record owns at most one drawing. Retire the original, reserve by Pine's
  // oldest-record order, then materialize the inverse even when the original
  // had already been hidden by the cap.
  fvg.visualVisible = false;
  reserveVisualSlot(runtime, owner);
  fvg.visualVisible = true;
  fvg.ifvgActive = true;
  fvg.ifvgAnalysisBirth = runtime.analysisBarId;
  fvg.lifecycle = 'inverted';
  fvg.bounceSignalCount = 0;
  fvg.sweepSignalCount = 0;
  fvg.lastBounceSignalAnalysisBar = 0;
  fvg.lastSweepSignalAnalysisBar = 0;
}

function processSide(runtime: UsrRuntime, owner: UsrFvg[], bullishOriginal: boolean): void {
  const candle = runtime.analysis[runtime.analysisBarId];
  const epsilon = runtime.settings.minimumTick * runtime.settings.breakBufferTicks;
  for (const fvg of owner) {
    if (fvg.ifvgActive) {
      const broken = bullishOriginal
        ? isAbove(runtime, candle.close, fvg.top)
        : isBelow(runtime, candle.close, fvg.bottom);
      const expired =
        runtime.analysisBarId - fvg.ifvgAnalysisBirth > runtime.settings.fvgMaxBarsActive;
      if (broken || expired) {
        fvg.ifvgActive = false;
        // Pine extends the box on the chart execution bar before retiring it.
        // For HTF analysis that is the first chart bar after the HTF close,
        // not the last constituent bar of the closed HTF candle.
        fvg.ifvgEndBar = candle.eventChartIndex;
        fvg.lifecycle = expired ? 'expired' : 'invalidated';
      }
      continue;
    }
    if (!fvg.isActive || runtime.analysisBarId <= fvg.analysisBirth) continue;
    const expired = runtime.analysisBarId - fvg.analysisBirth > runtime.settings.fvgMaxBarsActive;
    if (expired) {
      fvg.isActive = false;
      fvg.endBar = candle.eventChartIndex;
      fvg.lifecycle = 'expired';
      continue;
    }
    const size = fvg.top - fvg.bottom;
    const penetration = clamp(
      bullishOriginal ? (fvg.top - candle.low) / size : (candle.high - fvg.bottom) / size,
      0,
      1,
    );
    const farEdgeWicked = bullishOriginal ? candle.low <= fvg.bottom : candle.high >= fvg.top;
    const farEdgeClosed = bullishOriginal
      ? isBelow(runtime, candle.close, fvg.bottom)
      : isAbove(runtime, candle.close, fvg.top);
    const touched = bullishOriginal
      ? candle.low <= fvg.top + epsilon
      : candle.high >= fvg.bottom - epsilon;
    const closedInside = bullishOriginal
      ? candle.close <= fvg.top + epsilon
      : candle.close >= fvg.bottom - epsilon;
    let milestone: boolean;
    switch (runtime.settings.fvgFillMode) {
      case 'touch':
        milestone = touched;
        break;
      case 'close':
        milestone = closedInside;
        break;
      case 'percent':
        milestone = penetration >= runtime.settings.fvgFillPercent / 100;
        break;
      case 'ce':
        milestone = penetration >= 0.5;
        break;
    }
    if (milestone) fvg.milestoneReached = true;
    if (farEdgeClosed) {
      fvg.isActive = false;
      fvg.endBar = candle.eventChartIndex;
      fvg.lifecycle = runtime.settings.showIfvg ? 'inverted' : 'invalidated';
      activateInverse(runtime, owner, fvg);
    } else if (farEdgeWicked) {
      fvg.lifecycle = 'wick-filled';
    } else if (
      penetration >= 0.5 &&
      (fvg.lifecycle === 'untouched' || fvg.lifecycle === 'partial')
    ) {
      fvg.lifecycle = 'ce';
    } else if (penetration > 0 && fvg.lifecycle === 'untouched') {
      fvg.lifecycle = 'partial';
    }
  }
  enforceVisualCap(runtime, owner);
}

export function fvgStrength(runtime: UsrRuntime, fvg: UsrFvg, inverse: boolean): number {
  const birth = inverse ? fvg.ifvgAnalysisBirth : fvg.analysisBirth;
  const agePenalty = 1 / (1 + Math.max(runtime.analysisBarId - birth, 0) / 500);
  let lifecycle = 1;
  if (!inverse) {
    if (fvg.lifecycle === 'partial') lifecycle = 0.9;
    else if (fvg.lifecycle === 'ce') lifecycle = 0.78;
    else if (fvg.lifecycle === 'wick-filled') lifecycle = 0.65;
  }
  return (inverse ? 0.8 : 0.75) * lifecycle * agePenalty;
}

export function processUsrFvgEvent(runtime: UsrRuntime): void {
  if (!runtime.settings.showFvg) {
    runtime.bullishFvgs = [];
    runtime.bearishFvgs = [];
    return;
  }
  detect(runtime);
  processSide(runtime, runtime.bullishFvgs, true);
  processSide(runtime, runtime.bearishFvgs, false);
}
