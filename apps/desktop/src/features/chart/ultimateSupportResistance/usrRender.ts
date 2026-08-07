import {
  type ScriptBand,
  type ScriptRenderModel,
  type ScriptSegment,
  withScriptColorOpacity,
} from '../scriptOverlayTypes';
import { USR, USR_COLORS } from './usrConstants';
import type { UsrRuntime } from './usrRuntime';
import type { UsrConfluence, UsrFvg, UsrPool, UsrSignal, UsrZone } from './usrTypes';
import { recencyAdjustedPriority, zoneStrength } from './usrZones';

function inProximity(runtime: UsrRuntime, top: number, bottom: number, reference: number): boolean {
  if (!runtime.settings.enableProximityFilter || reference === 0) return true;
  const percent = runtime.settings.proximityPercent / 100;
  const low = Math.min(reference * (1 - percent), reference * (1 + percent));
  const high = Math.max(reference * (1 - percent), reference * (1 + percent));
  return !(bottom > high || top < low);
}

function zoneColor(zone: UsrZone): string {
  if (zone.isSupport) return zone.isFlipped ? USR_COLORS.flippedSupport : USR_COLORS.support;
  return zone.isFlipped ? USR_COLORS.flippedResistance : USR_COLORS.resistance;
}

function zoneRenderPriority(runtime: UsrRuntime, zone: UsrZone, lastBar: number): number {
  return (
    Number(zone.isActive) * 2 +
    recencyAdjustedPriority(
      zoneStrength(zone, runtime.analysisBarId),
      zone.activationBar > 0 ? zone.activationBar : zone.startBar,
      lastBar,
    )
  );
}

function zoneSegments(runtime: UsrRuntime, lastBar: number, reference: number): ScriptSegment[] {
  const effectiveFlippedOrigins =
    runtime.settings.showFlippedOrigins && runtime.settings.enableSrFlip;
  const effectiveAllBroken = runtime.settings.showAllBrokenLevels && !effectiveFlippedOrigins;
  return [...runtime.supportZones, ...runtime.resistanceZones]
    .filter((zone) => {
      const mature =
        zone.isFlipped || runtime.analysisBarId - zone.analysisBirth >= USR.minimumZoneAge;
      const invalidVisible =
        !zone.isActive &&
        (effectiveAllBroken || (effectiveFlippedOrigins && zone.hasActiveFlippedChild));
      const pooledHidden =
        runtime.settings.showLiquidityPools &&
        runtime.settings.hidePooledLines &&
        zone.inPool &&
        !zone.isFlipped;
      return (
        mature &&
        !pooledHidden &&
        (zone.isActive || invalidVisible) &&
        inProximity(runtime, zone.top, zone.bottom, reference)
      );
    })
    .sort(
      (a, b) => zoneRenderPriority(runtime, b, lastBar) - zoneRenderPriority(runtime, a, lastBar),
    )
    .slice(0, USR.maximumZoneLines)
    .map((zone) => ({
      x1: Math.max(0, zone.activationBar),
      y1: zone.isSupport ? zone.top : zone.bottom,
      x2: zone.isActive ? lastBar + USR.zoneExtendBars : Math.max(zone.endBar, zone.activationBar),
      y2: zone.isSupport ? zone.top : zone.bottom,
      color: zoneColor(zone),
      width: 2,
      style: zone.isActive ? ('solid' as const) : ('dashed' as const),
    }));
}

function confluenceBands(
  runtime: UsrRuntime,
  groups: UsrConfluence[],
  fillColor: string,
  borderColor: string,
  reference: number,
  budget: number,
  lastBar: number,
): ScriptBand[] {
  return groups
    .filter((group) => inProximity(runtime, group.top, group.bottom, reference))
    .slice(0, budget)
    .map((group) => ({
      x1: group.startBar,
      x2: lastBar + USR.zoneExtendBars,
      yTop: group.top,
      yBottom: group.bottom,
      fillColor,
      borderColor,
      borderWidth: group.isMixed ? 2 : 1,
      borderStyle: 'dotted',
    }));
}

function poolBands(
  runtime: UsrRuntime,
  pools: UsrPool[],
  reference: number,
  lastBar: number,
): ScriptBand[] {
  return pools
    .filter((pool) => inProximity(runtime, pool.top, pool.bottom, reference))
    .map((pool) => {
      const base = pool.isSupport ? USR_COLORS.supportBase : USR_COLORS.resistanceBase;
      let opacity = 0.15;
      if (pool.state === 'validated') opacity = 0.3;
      if (pool.state === 'swept') opacity = 0.35;
      let borderColor: string = pool.isSupport
        ? USR_COLORS.poolSupportBorder
        : USR_COLORS.poolResistanceBorder;
      if (pool.state === 'swept') borderColor = USR_COLORS.poolSweptBorder;
      return {
        x1: pool.startBar,
        x2: lastBar + USR.zoneExtendBars,
        yTop: pool.top,
        yBottom: pool.bottom,
        fillColor: withScriptColorOpacity(base, opacity),
        borderColor,
      };
    });
}

function visibleFvgs(runtime: UsrRuntime, records: UsrFvg[]): UsrFvg[] {
  return records.filter((fvg) => fvg.visualVisible).slice(0, runtime.settings.maxVisibleFvgs);
}

function fvgGeometry(
  runtime: UsrRuntime,
  records: UsrFvg[],
  lastBar: number,
): { bands: ScriptBand[]; segments: ScriptSegment[] } {
  const bands: ScriptBand[] = [];
  const segments: ScriptSegment[] = [];
  for (const fvg of visibleFvgs(runtime, records)) {
    const inverse = fvg.ifvgAnalysisBirth > 0;
    const active = inverse ? fvg.ifvgActive : fvg.isActive;
    let color: string;
    if (inverse) {
      color =
        fvg.direction === 'bullish'
          ? runtime.settings.ifvgBearishColor
          : runtime.settings.ifvgBullishColor;
    } else {
      color =
        fvg.direction === 'bullish'
          ? runtime.settings.fvgBullishColor
          : runtime.settings.fvgBearishColor;
    }
    const start = inverse
      ? (runtime.analysis[fvg.ifvgAnalysisBirth]?.eventChartIndex ?? fvg.startBar)
      : fvg.startBar;
    let end = lastBar;
    if (!active) end = inverse ? fvg.ifvgEndBar || lastBar : fvg.endBar || lastBar;
    let borderColor = withScriptColorOpacity(color, active ? 0.5 : 0.25);
    if (!inverse && active && fvg.milestoneReached) {
      borderColor = withScriptColorOpacity(runtime.settings.fvgCeColor, 0.75);
    }
    bands.push({
      x1: start,
      x2: end,
      yTop: fvg.top,
      yBottom: fvg.bottom,
      fillColor: active ? color : withScriptColorOpacity(color, 0.08),
      borderColor,
      borderWidth: !inverse && active && fvg.milestoneReached ? 2 : 1,
      borderStyle: active ? 'solid' : 'dotted',
    });
    if (runtime.settings.showFvgCe) {
      segments.push({
        x1: start,
        x2: end,
        y1: fvg.ce,
        y2: fvg.ce,
        color: active
          ? runtime.settings.fvgCeColor
          : withScriptColorOpacity(runtime.settings.fvgCeColor, 0.15),
        width: 1,
        style: 'dotted',
      });
    }
  }
  return { bands, segments };
}

function signalMarkers(runtime: UsrRuntime): ScriptRenderModel['markers'] {
  const both = runtime.settings.showBounceSignals && runtime.settings.showSweepSignals;
  let bounceLimit = 0;
  let sweepLimit = 0;
  if (both) {
    bounceLimit = Math.ceil(runtime.settings.maxRecentSignalsTotal / 2);
    sweepLimit = runtime.settings.maxRecentSignalsTotal - bounceLimit;
  } else {
    if (runtime.settings.showBounceSignals) bounceLimit = runtime.settings.maxRecentSignalsTotal;
    if (runtime.settings.showSweepSignals) sweepLimit = runtime.settings.maxRecentSignalsTotal;
  }
  const select = (kind: UsrSignal['kind'], limit: number): UsrSignal[] =>
    limit > 0 ? runtime.signals.filter((signal) => signal.kind === kind).slice(-limit) : [];
  return [...select('bounce', bounceLimit), ...select('sweep', sweepLimit)]
    .sort((a, b) => a.chartBarIndex - b.chartBarIndex)
    .map((signal) => ({
      barIndex: signal.chartBarIndex,
      placement: signal.bullish ? ('belowBar' as const) : ('aboveBar' as const),
      shape: signal.bullish ? ('labelUp' as const) : ('labelDown' as const),
      color: withScriptColorOpacity(signalColor(signal), 0.2),
      size: 'tiny' as const,
      text: signal.kind === 'sweep' ? 'S' : 'B',
      textColor: signalColor(signal),
    }));
}

function signalColor(signal: UsrSignal): string {
  if (signal.bullish) {
    return signal.kind === 'sweep' ? USR_COLORS.bullishSweep : USR_COLORS.bullishBounce;
  }
  return signal.kind === 'sweep' ? USR_COLORS.bearishSweep : USR_COLORS.bearishBounce;
}

function fvgLabel(runtime: UsrRuntime, fvg: UsrFvg): ScriptRenderModel['labels'][number] {
  const inverse = fvg.ifvgAnalysisBirth > 0;
  const active = inverse ? fvg.ifvgActive : fvg.isActive;
  let sign = fvg.direction === 'bullish' ? '+' : '-';
  if (inverse) sign = fvg.direction === 'bullish' ? '-' : '+';
  let text = `${inverse ? 'IFVG' : 'FVG'}${sign}`;
  if (!inverse && active && fvg.milestoneReached) text += ' M';
  if (!active) {
    if (fvg.lifecycle === 'expired') text += ' EXPIRED';
    else text += inverse ? ' INVALID' : ' FILLED';
  }
  return {
    barIndex: inverse
      ? (runtime.analysis[fvg.ifvgAnalysisBirth]?.eventChartIndex ?? fvg.startBar)
      : fvg.startBar,
    price: fvg.ce,
    text,
    textColor: 'rgba(255, 255, 255, 0.65)',
    align: 'left',
  };
}

export function renderUsr(
  runtime: UsrRuntime,
  lastBar: number,
  reference: number,
): ScriptRenderModel {
  const segments = zoneSegments(runtime, lastBar, reference);
  const bands: ScriptBand[] = [];
  if (runtime.settings.showConfluence) {
    const supportLimit = Math.floor(USR.maximumConfluences / 3);
    const resistanceLimit = Math.floor((USR.maximumConfluences * 2) / 3);
    const supportBands = confluenceBands(
      runtime,
      runtime.supportConfluences,
      USR_COLORS.confluenceSupport,
      USR_COLORS.confluenceSupportBorder,
      reference,
      supportLimit,
      lastBar,
    );
    bands.push(...supportBands);
    const resistanceBands = confluenceBands(
      runtime,
      runtime.resistanceConfluences,
      USR_COLORS.confluenceResistance,
      USR_COLORS.confluenceResistanceBorder,
      reference,
      Math.max(0, resistanceLimit - supportBands.length),
      lastBar,
    );
    bands.push(...resistanceBands);
    bands.push(
      ...confluenceBands(
        runtime,
        runtime.mixedConfluences,
        USR_COLORS.confluenceMixed,
        USR_COLORS.confluenceMixedBorder,
        reference,
        Math.max(0, USR.maximumConfluences - supportBands.length - resistanceBands.length),
        lastBar,
      ),
    );
  }
  if (runtime.settings.showLiquidityPools) {
    bands.push(
      ...poolBands(runtime, runtime.supportPools, reference, lastBar),
      ...poolBands(runtime, runtime.resistancePools, reference, lastBar),
    );
  }
  const bullish = fvgGeometry(runtime, runtime.bullishFvgs, lastBar);
  const bearish = fvgGeometry(runtime, runtime.bearishFvgs, lastBar);
  if (runtime.settings.showFvg) {
    bands.push(...bullish.bands, ...bearish.bands);
    segments.push(...bullish.segments, ...bearish.segments);
  }
  const labels = runtime.settings.showFvgLabels
    ? [runtime.bullishFvgs, runtime.bearishFvgs].flatMap((records) =>
        visibleFvgs(runtime, records).map((fvg) => fvgLabel(runtime, fvg)),
      )
    : [];
  return {
    candleColors: null,
    markers: signalMarkers(runtime),
    lines: [],
    fills: [],
    segments,
    bands,
    labels,
    banner: null,
  };
}
