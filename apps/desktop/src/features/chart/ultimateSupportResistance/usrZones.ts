import { USR } from './usrConstants';
import {
  clamp,
  isDirectionalDisplacement,
  isVolumeAnomaly,
  quantizedPriceKey,
  volumeRatio,
} from './usrMath';
import type { UsrRuntime } from './usrRuntime';
import type { UsrAnalysisCandle, UsrZone } from './usrTypes';

export function isAbove(runtime: UsrRuntime, price: number, boundary: number): boolean {
  return price >= boundary + runtime.settings.minimumTick * runtime.settings.breakBufferTicks;
}

export function isBelow(runtime: UsrRuntime, price: number, boundary: number): boolean {
  return price <= boundary - runtime.settings.minimumTick * runtime.settings.breakBufferTicks;
}

export function hasForce(runtime: UsrRuntime, candle: UsrAnalysisCandle): boolean {
  const candleWithAtr = { ...candle, atr: activeAnalysisAtr(runtime, candle) };
  return (
    isVolumeAnomaly(
      candleWithAtr,
      runtime.settings.minimumRelativeVolume,
      runtime.settings.minimumVolumeZScore,
    ) ||
    isDirectionalDisplacement(
      candleWithAtr,
      true,
      runtime.settings.displacementBodyPercent,
      runtime.settings.displacementAtrMultiplier,
      runtime.settings.minimumTick,
    ) ||
    isDirectionalDisplacement(
      candleWithAtr,
      false,
      runtime.settings.displacementBodyPercent,
      runtime.settings.displacementAtrMultiplier,
      runtime.settings.minimumTick,
    )
  );
}

/**
 * Pine substitutes 2% of price while chart ATR is seeding, and the latest
 * confirmed true range while requested-timeframe ATR is warming.
 */
export function activeAnalysisAtr(runtime: UsrRuntime, candle: UsrAnalysisCandle): number {
  if (candle.atr !== null) return candle.atr;
  if (runtime.timeframeTag === 'chart') {
    return Math.max(Math.abs(candle.close) * 0.02, runtime.settings.minimumTick);
  }
  return Math.max(candle.high - candle.low, runtime.settings.minimumTick);
}

export function zoneStrength(zone: UsrZone, analysisBarId: number): number {
  const normalizedVolume = clamp((zone.volumeRatio - 1) / 2, 0, 1);
  const volumeStrength = 0.35 + normalizedVolume * 0.65;
  const agePenalty = 1 / (1 + Math.max(analysisBarId - zone.analysisBirth, 0) / 750);
  const touchPenalty = 0.84 ** Math.max(zone.touchCount - 1, 0);
  let statePenalty = 0.62;
  if (zone.state === 'fresh') statePenalty = 1;
  else if (zone.state === 'tested') statePenalty = 0.88;
  const flipPenalty = zone.isFlipped ? 0.82 : 1;
  return clamp(volumeStrength * agePenalty * touchPenalty * statePenalty * flipPenalty, 0.05, 1);
}

/** Pine's bounded selectors add a small, causal recency component to strength. */
export function recencyAdjustedPriority(
  strength: number,
  causalStart: number,
  currentChartBar: number,
): number {
  return strength + (currentChartBar > 0 ? (causalStart / currentChartBar) * 0.001 : 0);
}

function validBounds(top: number, bottom: number): boolean {
  return Number.isFinite(top) && Number.isFinite(bottom) && top >= bottom;
}

function invalidates(
  runtime: UsrRuntime,
  candle: UsrAnalysisCandle,
  previous: UsrAnalysisCandle | undefined,
  top: number,
  bottom: number,
  support: boolean,
): boolean {
  if (!validBounds(top, bottom)) return false;
  const forceBreak =
    hasForce(runtime, candle) &&
    (support ? isBelow(runtime, candle.close, bottom) : isAbove(runtime, candle.close, top));
  if (forceBreak) return true;
  if (!previous) return false;
  const gapThreshold = activeAnalysisAtr(runtime, candle) * runtime.settings.gapAtrMultiplier;
  if (support) {
    return (
      previous.low > top &&
      isBelow(runtime, candle.high, bottom) &&
      isBelow(runtime, candle.close, bottom) &&
      previous.low - candle.high >= gapThreshold
    );
  }
  return (
    previous.high < bottom &&
    isAbove(runtime, candle.low, top) &&
    isAbove(runtime, candle.close, top) &&
    candle.low - previous.high >= gapThreshold
  );
}

function brokenBetween(
  runtime: UsrRuntime,
  top: number,
  bottom: number,
  support: boolean,
  originIndex: number,
  detectionIndex: number,
): boolean {
  const start = Math.max(originIndex + 1, detectionIndex - 99);
  for (let index = start; index <= detectionIndex; index += 1) {
    if (
      invalidates(
        runtime,
        runtime.analysis[index],
        runtime.analysis[index - 1],
        top,
        bottom,
        support,
      )
    ) {
      return true;
    }
  }
  return false;
}

function candidateKey(
  runtime: UsrRuntime,
  origin: UsrAnalysisCandle,
  top: number,
  bottom: number,
  support: boolean,
): string {
  const tick = runtime.settings.minimumTick;
  return `${runtime.timeframeTag}|${origin.chartEndIndex}|${support ? 'S' : 'R'}|${quantizedPriceKey(top, tick)}|${quantizedPriceKey(bottom, tick)}`;
}

interface PendingZoneDraft {
  top: number;
  bottom: number;
  originIndex: number;
  support: boolean;
  relativeVolume: number;
  detectionIndex: number;
  sourceId: number;
}

interface PendingZoneQueues {
  support: PendingZoneDraft[];
  resistance: PendingZoneDraft[];
}

function queueZone(
  runtime: UsrRuntime,
  pending: PendingZoneQueues,
  top: number,
  bottom: number,
  originIndex: number,
  support: boolean,
  relativeVolume: number,
  detectionIndex: number,
): void {
  if (
    !validBounds(top, bottom) ||
    brokenBetween(runtime, top, bottom, support, originIndex, detectionIndex)
  ) {
    return;
  }
  const origin = runtime.analysis[originIndex];
  const key = candidateKey(runtime, origin, top, bottom, support);
  if (runtime.processedCandidates.has(key)) return;
  runtime.processedCandidates.add(key);
  runtime.candidateOrder.push(key);
  if (runtime.candidateOrder.length > USR.maximumCandidateKeys) {
    const removed = runtime.candidateOrder.shift();
    if (removed) runtime.processedCandidates.delete(removed);
  }
  // Pine assigns the immutable setup identity when the candidate is queued.
  // A distinct zone identity is assigned later when pending candidates commit.
  runtime.identity += 1;
  (support ? pending.support : pending.resistance).push({
    top,
    bottom,
    originIndex,
    support,
    relativeVolume,
    detectionIndex,
    sourceId: runtime.identity,
  });
}

function materializeZone(
  runtime: UsrRuntime,
  top: number,
  bottom: number,
  originIndex: number,
  support: boolean,
  relativeVolume: number,
  detectionIndex: number,
  flipped: boolean,
  sourceId: number,
  parent?: UsrZone,
): UsrZone | null {
  if (!validBounds(top, bottom)) return null;
  const origin = runtime.analysis[originIndex];
  const detection = runtime.analysis[detectionIndex];
  runtime.identity += 1;
  const originId = parent ? parent.originZoneId || parent.id : 0;
  let originIsSupport = true;
  if (parent) originIsSupport = parent.originZoneId ? parent.originIsSupport : parent.isSupport;
  const zone: UsrZone = {
    id: runtime.identity,
    sourceId,
    analysisBirth: detectionIndex,
    top,
    bottom,
    startBar: flipped ? detection.chartEndIndex : origin.chartEndIndex,
    sourceTime: parent?.sourceTime ?? origin.time,
    detectedTime: detection.closeTime,
    activeTime: flipped ? detection.closeTime : detection.eventTime,
    invalidatedTime: null,
    activationBar: detection.eventChartIndex,
    endBar: 0,
    isSupport: support,
    isActive: true,
    volumeRatio: Math.max(relativeVolume, 0),
    state: 'fresh',
    touchCount: 0,
    maxPenetration: 0,
    isFlipped: flipped,
    isLine: top === bottom,
    lastTouchAnalysisBar: null,
    wasInsideLastBar: false,
    originStartBar: parent ? parent.originStartBar || parent.startBar : 0,
    originZoneId: originId,
    originIsSupport,
    hasActiveFlippedChild: false,
    inPool: false,
    poolId: '',
    bounceSignalCount: 0,
    sweepSignalCount: 0,
    lastBounceSignalBar: 0,
    lastSweepSignalBar: 0,
  };
  (support ? runtime.supportZones : runtime.resistanceZones).push(zone);
  runtime.zonesChanged = true;
  return zone;
}

function commitPending(runtime: UsrRuntime, pending: PendingZoneQueues): void {
  // Pine drains each side from the end of its pending array. This restores
  // chronological same-side ordering after the detector's newest-first scan.
  for (const drafts of [pending.support, pending.resistance]) {
    for (let index = drafts.length - 1; index >= 0; index -= 1) {
      const draft = drafts[index];
      materializeZone(
        runtime,
        draft.top,
        draft.bottom,
        draft.originIndex,
        draft.support,
        draft.relativeVolume,
        draft.detectionIndex,
        false,
        draft.sourceId,
      );
    }
  }
}

function pivotLow(runtime: UsrRuntime, index: number): boolean {
  const center = runtime.analysis[index]?.low;
  if (center === undefined) return false;
  for (let offset = 1; offset <= runtime.settings.pivotLeftBars; offset += 1) {
    if (
      runtime.analysis[index - offset]?.low === undefined ||
      center > runtime.analysis[index - offset].low
    )
      return false;
  }
  for (let offset = 1; offset <= runtime.settings.pivotRightBars; offset += 1) {
    if (
      runtime.analysis[index + offset]?.low === undefined ||
      center > runtime.analysis[index + offset].low
    )
      return false;
  }
  return true;
}

function pivotHigh(runtime: UsrRuntime, index: number): boolean {
  const center = runtime.analysis[index]?.high;
  if (center === undefined) return false;
  for (let offset = 1; offset <= runtime.settings.pivotLeftBars; offset += 1) {
    if (
      runtime.analysis[index - offset]?.high === undefined ||
      center < runtime.analysis[index - offset].high
    )
      return false;
  }
  for (let offset = 1; offset <= runtime.settings.pivotRightBars; offset += 1) {
    if (
      runtime.analysis[index + offset]?.high === undefined ||
      center < runtime.analysis[index + offset].high
    )
      return false;
  }
  return true;
}

function processMaturePivot(
  runtime: UsrRuntime,
  detectionIndex: number,
  pending: PendingZoneQueues,
): void {
  const originIndex = detectionIndex - runtime.settings.pivotRightBars;
  const candle = runtime.analysis[originIndex];
  if (
    !candle ||
    !isVolumeAnomaly(
      candle,
      runtime.settings.minimumRelativeVolume,
      runtime.settings.minimumVolumeZScore,
    )
  )
    return;
  const relativeVolume = volumeRatio(candle.volume, candle.volumeMean);
  if (pivotLow(runtime, originIndex)) {
    const level = Math.min(candle.open, candle.close);
    queueZone(runtime, pending, level, level, originIndex, true, relativeVolume, detectionIndex);
  }
  if (pivotHigh(runtime, originIndex)) {
    const level = Math.max(candle.open, candle.close);
    queueZone(runtime, pending, level, level, originIndex, false, relativeVolume, detectionIndex);
  }
}

function structureHigh(runtime: UsrRuntime, displacementIndex: number): number | null {
  const values = runtime.analysis.slice(
    displacementIndex - runtime.settings.structureLookback,
    displacementIndex,
  );
  return values.length === runtime.settings.structureLookback
    ? Math.max(...values.map((bar) => bar.high))
    : null;
}

function structureLow(runtime: UsrRuntime, displacementIndex: number): number | null {
  const values = runtime.analysis.slice(
    displacementIndex - runtime.settings.structureLookback,
    displacementIndex,
  );
  return values.length === runtime.settings.structureLookback
    ? Math.min(...values.map((bar) => bar.low))
    : null;
}

function processSequenceBar(
  runtime: UsrRuntime,
  index: number,
  detectionIndex: number,
  pending: PendingZoneQueues,
): void {
  const candle = runtime.analysis[index];
  const previous = runtime.analysis[index - 1];
  if (!candle || !previous) return;
  const relativeVolume = volumeRatio(candle.volume, candle.volumeMean);
  const minimumGap = activeAnalysisAtr(runtime, candle) * runtime.settings.gapAtrMultiplier;
  const openingUp = candle.open - previous.close >= minimumGap;
  const openingDown = previous.close - candle.open >= minimumGap;
  const voidUp = candle.low - previous.high >= minimumGap;
  const voidDown = previous.low - candle.high >= minimumGap;
  const gapUp = runtime.settings.requirePriceVoidGaps
    ? voidUp
    : openingUp && candle.low - previous.close >= minimumGap;
  const gapDown = runtime.settings.requirePriceVoidGaps
    ? voidDown
    : openingDown && previous.close - candle.high >= minimumGap;
  if (gapUp) {
    queueZone(
      runtime,
      pending,
      candle.low,
      runtime.settings.requirePriceVoidGaps ? previous.high : previous.close,
      index,
      true,
      relativeVolume,
      detectionIndex,
    );
  }
  if (gapDown) {
    queueZone(
      runtime,
      pending,
      runtime.settings.requirePriceVoidGaps ? previous.low : previous.close,
      candle.high,
      index,
      false,
      relativeVolume,
      detectionIndex,
    );
  }

  const origin = runtime.analysis[index - 1];
  // A force-chunk can end on the current analysis bar. Its follow-through bar
  // exists in a full historical array but was not known at this event time.
  const follow = index + 1 <= detectionIndex ? runtime.analysis[index + 1] : undefined;
  if (!origin || !follow) return;
  const priorHigh = structureHigh(runtime, index);
  const priorLow = structureLow(runtime, index);
  const midpoint = (candle.open + candle.close) / 2;
  const bullishBreak =
    origin.close < origin.open &&
    priorHigh !== null &&
    isDirectionalDisplacement(
      { ...candle, atr: activeAnalysisAtr(runtime, candle) },
      true,
      runtime.settings.displacementBodyPercent,
      runtime.settings.displacementAtrMultiplier,
      runtime.settings.minimumTick,
    ) &&
    isAbove(runtime, candle.close, priorHigh);
  if (
    bullishBreak &&
    follow.close >= midpoint &&
    isAbove(runtime, follow.close, priorHigh as number)
  ) {
    queueZone(
      runtime,
      pending,
      runtime.settings.orderBlockUseWicks ? origin.high : origin.open,
      runtime.settings.orderBlockUseWicks ? origin.low : origin.close,
      index - 1,
      true,
      relativeVolume,
      detectionIndex,
    );
  }
  const bearishBreak =
    origin.close > origin.open &&
    priorLow !== null &&
    isDirectionalDisplacement(
      { ...candle, atr: activeAnalysisAtr(runtime, candle) },
      false,
      runtime.settings.displacementBodyPercent,
      runtime.settings.displacementAtrMultiplier,
      runtime.settings.minimumTick,
    ) &&
    isBelow(runtime, candle.close, priorLow);
  if (
    bearishBreak &&
    follow.close <= midpoint &&
    isBelow(runtime, follow.close, priorLow as number)
  ) {
    queueZone(
      runtime,
      pending,
      runtime.settings.orderBlockUseWicks ? origin.high : origin.close,
      runtime.settings.orderBlockUseWicks ? origin.low : origin.open,
      index - 1,
      false,
      relativeVolume,
      detectionIndex,
    );
  }
}

function processSequence(
  runtime: UsrRuntime,
  newestIndex: number,
  count: number,
  detectionIndex: number,
  pending: PendingZoneQueues,
): void {
  for (let scanned = 0; scanned < count; scanned += 1) {
    const index = newestIndex - scanned;
    const candle = runtime.analysis[index];
    if (
      !candle ||
      !isVolumeAnomaly(
        candle,
        runtime.settings.minimumRelativeVolume,
        runtime.settings.minimumVolumeZScore,
      )
    )
      break;
    processSequenceBar(runtime, index, detectionIndex, pending);
  }
}

function flip(runtime: UsrRuntime, zone: UsrZone, index: number): void {
  const child = materializeZone(
    runtime,
    zone.top,
    zone.bottom,
    index,
    !zone.isSupport,
    zone.volumeRatio,
    index,
    true,
    zone.sourceId,
    zone,
  );
  if (!child) return;
  if (zone.originZoneId > 0) {
    zone.hasActiveFlippedChild = false;
    const origin = [...runtime.supportZones, ...runtime.resistanceZones].find(
      (candidate) => candidate.id === zone.originZoneId,
    );
    if (origin) origin.hasActiveFlippedChild = true;
  } else {
    zone.hasActiveFlippedChild = true;
  }
}

function updateState(
  runtime: UsrRuntime,
  zone: UsrZone,
  candle: UsrAnalysisCandle,
  index: number,
): boolean {
  if (!zone.isActive || index <= zone.analysisBirth) return false;
  let strengthStateChanged = false;
  const height = zone.top - zone.bottom;
  const tolerance = activeAnalysisAtr(runtime, candle) * 0.05;
  const epsilon = runtime.settings.minimumTick * runtime.settings.breakBufferTicks;
  const entered =
    height === 0
      ? candle.low <= zone.top + tolerance && candle.high >= zone.bottom - tolerance
      : candle.low <= zone.top + epsilon && candle.high >= zone.bottom - epsilon;
  if (entered && !zone.wasInsideLastBar && zone.lastTouchAnalysisBar !== index) {
    zone.touchCount += 1;
    zone.lastTouchAnalysisBar = index;
    strengthStateChanged = true;
    if (zone.state === 'fresh') zone.state = 'tested';
  }
  if (entered && height > 0) {
    const penetration = zone.isSupport
      ? (zone.top - candle.low) / height
      : (candle.high - zone.bottom) / height;
    zone.maxPenetration = Math.max(zone.maxPenetration, clamp(penetration, 0, 1));
    if (
      zone.maxPenetration >= runtime.settings.zoneMitigationPercent &&
      zone.state !== 'mitigated'
    ) {
      zone.state = 'mitigated';
      strengthStateChanged = true;
    }
  }
  zone.wasInsideLastBar = entered;
  return strengthStateChanged;
}

function processLifecycle(runtime: UsrRuntime, index: number): void {
  const candle = runtime.analysis[index];
  const previous = runtime.analysis[index - 1];
  const processZone = (zone: UsrZone): void => {
    if (
      zone.isActive &&
      index > zone.analysisBirth &&
      invalidates(runtime, candle, previous, zone.top, zone.bottom, zone.isSupport)
    ) {
      if (runtime.settings.enableSrFlip) flip(runtime, zone, index);
      zone.isActive = false;
      zone.invalidatedTime = candle.closeTime;
      zone.endBar = candle.chartEndIndex;
      runtime.zonesChanged = true;
    }
    if (updateState(runtime, zone, candle, index)) runtime.zonesChanged = true;
  };
  // Pine processes each side newest-to-oldest, with support first. Support
  // flips are therefore present when the resistance-side pass begins, while
  // resistance flips do not retroactively enter the completed support pass.
  for (let position = runtime.supportZones.length - 1; position >= 0; position -= 1) {
    processZone(runtime.supportZones[position]);
  }
  for (let position = runtime.resistanceZones.length - 1; position >= 0; position -= 1) {
    processZone(runtime.resistanceZones[position]);
  }
}

function trimZones(runtime: UsrRuntime): void {
  const total = runtime.settings.maxSupportLevels + runtime.settings.maxResistanceLevels;
  const supportSurplus = Math.max(
    0,
    runtime.settings.maxSupportLevels - runtime.supportZones.length,
  );
  const resistanceSurplus = Math.max(
    0,
    runtime.settings.maxResistanceLevels - runtime.resistanceZones.length,
  );
  const supportMaximum = Math.max(
    1,
    Math.min(
      runtime.settings.maxSupportLevels + resistanceSurplus,
      total - Math.min(runtime.resistanceZones.length, runtime.settings.maxResistanceLevels),
    ),
  );
  const resistanceMaximum = Math.max(
    1,
    Math.min(
      runtime.settings.maxResistanceLevels + supportSurplus,
      total - Math.min(runtime.supportZones.length, runtime.settings.maxSupportLevels),
    ),
  );
  if (runtime.supportZones.length > supportMaximum) {
    const removed = runtime.supportZones.splice(0, runtime.supportZones.length - supportMaximum);
    releaseTrimmedFlipOrigins(runtime, removed);
    runtime.zonesChanged = true;
  }
  if (runtime.resistanceZones.length > resistanceMaximum) {
    const removed = runtime.resistanceZones.splice(
      0,
      runtime.resistanceZones.length - resistanceMaximum,
    );
    releaseTrimmedFlipOrigins(runtime, removed);
    runtime.zonesChanged = true;
  }
}

function releaseTrimmedFlipOrigins(runtime: UsrRuntime, removed: readonly UsrZone[]): void {
  const originIds = new Set(
    removed
      .filter((zone) => zone.isFlipped && zone.originZoneId > 0)
      .map((zone) => zone.originZoneId),
  );
  if (originIds.size === 0) return;
  for (const origin of [...runtime.supportZones, ...runtime.resistanceZones]) {
    if (originIds.has(origin.id)) origin.hasActiveFlippedChild = false;
  }
}

export function processUsrZoneEvent(runtime: UsrRuntime, index: number): void {
  runtime.analysisBarId = index;
  runtime.zonesChanged = false;
  const pending: PendingZoneQueues = { support: [], resistance: [] };
  processMaturePivot(runtime, index, pending);
  const candle = runtime.analysis[index];
  const anomalous = isVolumeAnomaly(
    candle,
    runtime.settings.minimumRelativeVolume,
    runtime.settings.minimumVolumeZScore,
  );
  if (anomalous) {
    runtime.highVolumeSequenceLength += 1;
    if (runtime.highVolumeSequenceLength >= runtime.settings.maxSequenceLength) {
      processSequence(runtime, index, runtime.highVolumeSequenceLength, index, pending);
      runtime.highVolumeSequenceLength = 1;
    }
  } else {
    const previous = runtime.analysis[index - 1];
    const previousAnomalous =
      previous &&
      isVolumeAnomaly(
        previous,
        runtime.settings.minimumRelativeVolume,
        runtime.settings.minimumVolumeZScore,
      );
    if (previousAnomalous && runtime.highVolumeSequenceLength > 0) {
      processSequence(runtime, index - 1, runtime.highVolumeSequenceLength, index, pending);
    }
    runtime.highVolumeSequenceLength = 0;
  }
  commitPending(runtime, pending);
  processLifecycle(runtime, index);
  trimZones(runtime);
}
