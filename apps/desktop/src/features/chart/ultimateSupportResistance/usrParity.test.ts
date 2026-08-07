import { describe, expect, it } from 'vitest';
import { computeUsr } from './computeUsr';
import { rebuildUsrConfluences, rebuildUsrPools } from './usrDerived';
import { processUsrFvgEvent } from './usrFvg';
import { quantizedPriceKey } from './usrMath';
import { renderUsr } from './usrRender';
import { createUsrRuntime } from './usrRuntime';
import { DEFAULT_USR_SETTINGS } from './usrSettings';
import { parseUsrTimeframeValue, prepareUsrHistory } from './usrTimeframe';
import type { UsrAnalysisCandle, UsrCandle, UsrFvg, UsrZone } from './usrTypes';
import { processUsrZoneEvent } from './usrZones';

function settings() {
  return { ...DEFAULT_USR_SETTINGS, enabled: true, enableProximityFilter: false };
}

function analysisCandle(index: number, values: Partial<UsrAnalysisCandle> = {}): UsrAnalysisCandle {
  const time = 1_700_000_000 + index * 60;
  return {
    time,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100,
    chartStartIndex: index,
    chartEndIndex: index,
    eventChartIndex: index,
    eventTime: time + 60,
    closeTime: time + 60,
    regularSession: true,
    atr: 1,
    volumeMean: 100,
    volumeStd: 1,
    ...values,
  };
}

function zone(id: number, values: Partial<UsrZone> = {}): UsrZone {
  return {
    id,
    sourceId: id,
    analysisBirth: 0,
    top: 101,
    bottom: 99,
    startBar: id,
    sourceTime: id,
    detectedTime: id,
    activeTime: id,
    invalidatedTime: null,
    activationBar: id,
    endBar: 0,
    isSupport: true,
    isActive: true,
    volumeRatio: 3,
    state: 'fresh',
    touchCount: 0,
    maxPenetration: 0,
    isFlipped: false,
    isLine: false,
    lastTouchAnalysisBar: null,
    wasInsideLastBar: false,
    originStartBar: 0,
    originZoneId: 0,
    originIsSupport: true,
    hasActiveFlippedChild: false,
    inPool: false,
    poolId: '',
    bounceSignalCount: 0,
    sweepSignalCount: 0,
    lastBounceSignalBar: 0,
    lastSweepSignalBar: 0,
    ...values,
  };
}

function fvg(values: Partial<UsrFvg> = {}): UsrFvg {
  return {
    id: 'old',
    visualVisible: true,
    top: 110,
    bottom: 105,
    ce: 107.5,
    startBar: 0,
    analysisBirth: 0,
    ifvgAnalysisBirth: 0,
    endBar: 0,
    ifvgEndBar: 0,
    direction: 'bullish',
    isActive: true,
    lifecycle: 'untouched',
    milestoneReached: false,
    ifvgActive: false,
    bounceSignalCount: 0,
    sweepSignalCount: 0,
    lastBounceSignalAnalysisBar: 0,
    lastSweepSignalAnalysisBar: 0,
    ...values,
  };
}

describe('Ultimate S/R Pine parity edges', () => {
  it('uses Pine upward midpoint rounding for quantized identities', () => {
    expect(quantizedPriceKey(1.5, 1)).toBe('2');
    expect(quantizedPriceKey(-1.5, 1)).toBe('-1');
    expect(quantizedPriceKey(-0.5, 1)).toBe('0');
    expect(quantizedPriceKey(1e20, 0.000_001)).toBe('bits:4554adf4b7320335');
    expect(quantizedPriceKey(Number.MAX_VALUE, 0.000_001)).toBe('price-bits:7fefffffffffffff');
  });

  it('accepts Pine timeframe aliases and only Pine-supported tick multipliers', () => {
    expect(parseUsrTimeframeValue('D')?.tag).toBe('1D');
    expect(parseUsrTimeframeValue('W')?.tag).toBe('1W');
    expect(parseUsrTimeframeValue('M')?.tag).toBe('1M');
    expect(parseUsrTimeframeValue('S')?.tag).toBe('1S');
    expect(parseUsrTimeframeValue('T')?.tag).toBe('1T');
    expect(parseUsrTimeframeValue('1000T')?.ticks).toBe(1_000);
    expect(parseUsrTimeframeValue('25T')).toBeNull();
    expect(parseUsrTimeframeValue('1H')).toBeNull();
  });

  it('falls back to chart bars when Pine cannot compare a tick clock in seconds', () => {
    const candles = Array.from({ length: 21 }, (_, index): UsrCandle => ({
      time: 1_700_000_000 + index,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 10,
    }));
    const result = computeUsr(
      candles,
      { ...settings(), analysisTimeframe: 'custom', customTimeframe: '100T' },
      {
        chartIntervalSeconds: null,
        now: candles.at(-1)!.time,
        lastCandleIsOpen: false,
      },
    )!;
    expect(result.diagnostics.usedChartTimeframe).toBe(true);
    expect(result.diagnostics.analysisTimeframeTag).toBe('chart');
    expect(result.diagnostics.analysisBars).toBe(21);
  });

  it('keeps the last valid provider correction for a duplicate timestamp', () => {
    const first: UsrCandle = { time: 100, open: 10, high: 12, low: 9, close: 11, volume: 10 };
    const correction: UsrCandle = { ...first, close: 11.5, volume: 20 };
    const prepared = prepareUsrHistory([first, correction], settings(), {
      chartIntervalSeconds: 60,
      now: 1_000,
      lastCandleIsOpen: false,
    });
    expect(prepared.chartCandles).toEqual([correction]);
    expect(prepared.warnings).toHaveLength(1);
  });

  it('treats continuous crypto volume as one exchange session', () => {
    const candles: UsrCandle[] = [];
    let date = Date.UTC(2026, 0, 5) / 1_000;
    let weekdays = 0;
    while (weekdays < 10) {
      const weekday = new Date(date * 1_000).getUTCDay();
      if (weekday >= 1 && weekday <= 5) {
        candles.push({
          time: date + 15 * 3_600,
          open: 100,
          high: 101,
          low: 99,
          close: 100,
          volume: 100,
        });
        candles.push({
          time: date + 22 * 3_600,
          open: 100,
          high: 101,
          low: 99,
          close: 100,
          volume: 10,
        });
        weekdays += 1;
      }
      date += 86_400;
    }
    while ([0, 6].includes(new Date(date * 1_000).getUTCDay())) date += 86_400;
    const finalTime = date + 15 * 3_600;
    candles.push({ time: finalTime, open: 100, high: 101, low: 99, close: 100, volume: 100 });
    const regular = prepareUsrHistory(
      candles,
      { ...settings(), volumeLookback: 10 },
      {
        chartIntervalSeconds: 60,
        now: finalTime + 120,
        lastCandleIsOpen: false,
      },
    );
    const continuous = prepareUsrHistory(
      candles,
      { ...settings(), volumeLookback: 10 },
      {
        chartIntervalSeconds: 60,
        continuousSession: true,
        now: finalTime + 120,
        lastCandleIsOpen: false,
      },
    );
    expect(regular.analysisCandles.at(-1)?.volumeMean).toBe(100);
    expect(continuous.analysisCandles.at(-1)?.volumeMean).toBe(55);
  });

  it('uses Pine cumulative confluence budgets instead of fixed thirds', () => {
    const runtime = createUsrRuntime(
      { ...settings(), showConfluence: true, showLiquidityPools: false, showFvg: false },
      [analysisCandle(0)],
      'chart',
    );
    runtime.analysisBarId = 0;
    runtime.resistanceConfluences = Array.from({ length: 40 }, (_, index) => ({
      top: 110 + index,
      bottom: 109 + index,
      startBar: 0,
      isMixed: false,
      memberIds: [],
      strength: 1,
    }));
    runtime.mixedConfluences = Array.from({ length: 40 }, (_, index) => ({
      top: 210 + index,
      bottom: 209 + index,
      startBar: 0,
      isMixed: true,
      memberIds: [],
      strength: 1,
    }));
    const bands = renderUsr(runtime, 0, 100).bands;
    expect(bands).toHaveLength(60);
    expect(bands.filter((band) => band.borderWidth === 2)).toHaveLength(20);
  });

  it('never renders a disabled signal class from a defensively supplied history', () => {
    const runtime = createUsrRuntime(
      {
        ...settings(),
        showBounceSignals: false,
        showSweepSignals: true,
        showLiquidityPools: false,
        showFvg: false,
      },
      [analysisCandle(0)],
      'chart',
    );
    runtime.analysisBarId = 0;
    runtime.signals = [
      {
        bullish: true,
        kind: 'bounce',
        source: 'zone',
        chartBarIndex: 0,
        analysisBarId: 0,
        price: 100,
        stop: 99,
        score: 1,
        sourceKey: 'bounce',
      },
      {
        bullish: true,
        kind: 'sweep',
        source: 'zone',
        chartBarIndex: 0,
        analysisBarId: 0,
        price: 100,
        stop: 99,
        score: 1,
        sourceKey: 'sweep',
      },
    ];
    expect(renderUsr(runtime, 0, 100).markers.map((marker) => marker.text)).toEqual(['S']);
  });

  it('preserves newest-first Pine membership below confluence and pool caps', () => {
    const runtime = createUsrRuntime(
      { ...settings(), poolClusterThreshold: 3 },
      [analysisCandle(0), analysisCandle(1)],
      'chart',
    );
    runtime.analysisBarId = 0;
    runtime.supportZones = [zone(1), zone(2), zone(3)];
    rebuildUsrConfluences(runtime);
    expect(runtime.supportConfluences[0].memberIds).toEqual([3, 2, 1]);

    runtime.supportZones = [
      zone(1, { top: 100, bottom: 100, isLine: true }),
      zone(2, { top: 100, bottom: 100, isLine: true }),
      zone(3, { top: 100, bottom: 100, isLine: true }),
    ];
    rebuildUsrPools(runtime);
    expect(runtime.supportPools[0].id).toBe('PS|3|2|1');
    runtime.supportPools[0].state = 'swept';
    runtime.supportPools[0].bounceSignalCount = 2;
    runtime.analysisBarId = 1;
    rebuildUsrPools(runtime);
    expect(runtime.supportPools[0]).toMatchObject({
      id: 'PS|3|2|1',
      state: 'swept',
      bounceSignalCount: 2,
      analysisBirth: 0,
    });
  });

  it('allocates simultaneous flip identities in Pine newest-first side order', () => {
    const runtime = createUsrRuntime(
      settings(),
      [analysisCandle(0), analysisCandle(1, { open: 100, high: 101, low: 89, close: 90 })],
      'chart',
    );
    runtime.identity = 20;
    runtime.supportZones = [
      zone(10, { top: 96, bottom: 95, startBar: 0, activationBar: 0 }),
      zone(20, { top: 94, bottom: 93, startBar: 0, activationBar: 0 }),
    ];

    processUsrZoneEvent(runtime, 1);

    expect(runtime.supportZones.map((candidate) => candidate.isActive)).toEqual([false, false]);
    expect(runtime.resistanceZones.map((candidate) => candidate.originZoneId)).toEqual([20, 10]);
    expect(runtime.resistanceZones.map((candidate) => candidate.id)).toEqual([21, 22]);
  });

  it('lets the final same-bar IFVG visual evict an earlier new FVG like Pine', () => {
    const analysis = [
      analysisCandle(0, { open: 90, high: 91, low: 89, close: 90 }),
      analysisCandle(1, { open: 90, high: 91, low: 89, close: 90 }),
      analysisCandle(2, { open: 89, high: 91, low: 88, close: 90 }),
      analysisCandle(3, { open: 92, high: 100.2, low: 91.8, close: 100 }),
      analysisCandle(4, { open: 96, high: 101, low: 95, close: 100 }),
    ];
    const runtime = createUsrRuntime(
      {
        ...settings(),
        showFvg: true,
        showIfvg: true,
        fvgLookback: 3,
        fvgBodyPercent: 0.05,
        fvgMinBodyAtr: 0,
        fvgMinGapAtr: 0,
        maxVisibleFvgs: 1,
      },
      analysis,
      'chart',
    );
    runtime.analysisBarId = 4;
    runtime.bullishFvgs = [fvg()];
    processUsrFvgEvent(runtime);
    expect(runtime.bullishFvgs).toHaveLength(2);
    expect(runtime.bullishFvgs[0]).toMatchObject({ visualVisible: false });
    expect(runtime.bullishFvgs[1]).toMatchObject({ ifvgActive: true, visualVisible: true });
    const bands = renderUsr(runtime, 4, 100).bands;
    expect(bands).toHaveLength(1);
    expect(bands[0]).toMatchObject({ yTop: 110, yBottom: 105 });
  });

  it('reserves an IFVG slot by Pine record order, not visual recency', () => {
    const runtime = createUsrRuntime(
      {
        ...settings(),
        showFvg: true,
        showIfvg: true,
        maxVisibleFvgs: 2,
        fvgLookback: 3,
      },
      [analysisCandle(0), analysisCandle(1, { close: 80, low: 79 })],
      'chart',
    );
    runtime.analysisBarId = 1;
    runtime.bullishFvgs = [
      fvg({ id: 'newest', top: 130, bottom: 125, isActive: false }),
      fvg({ id: 'hidden', top: 95, bottom: 90, visualVisible: false }),
      fvg({
        id: 'oldest-visible',
        top: 200,
        bottom: 195,
        isActive: false,
        ifvgActive: true,
        ifvgAnalysisBirth: 0,
      }),
    ];
    processUsrFvgEvent(runtime);
    expect(runtime.bullishFvgs.map(({ id, visualVisible }) => [id, visualVisible])).toEqual([
      ['newest', true],
      ['hidden', true],
      ['oldest-visible', false],
    ]);
  });

  it('retires HTF FVG and IFVG drawings on the chart event bar', () => {
    const originalRuntime = createUsrRuntime(
      { ...settings(), showFvg: true, showIfvg: false },
      [
        analysisCandle(0),
        analysisCandle(1, { chartEndIndex: 9, eventChartIndex: 10, close: 100, low: 99 }),
      ],
      '4h',
    );
    originalRuntime.analysisBarId = 1;
    originalRuntime.bullishFvgs = [fvg()];

    processUsrFvgEvent(originalRuntime);

    expect(originalRuntime.bullishFvgs[0]).toMatchObject({
      isActive: false,
      endBar: 10,
      lifecycle: 'invalidated',
    });
    expect(renderUsr(originalRuntime, 10, 100).bands[0]?.x2).toBe(10);

    const inverseRuntime = createUsrRuntime(
      { ...settings(), showFvg: true, showIfvg: true },
      [
        analysisCandle(0),
        analysisCandle(1),
        analysisCandle(2, { chartEndIndex: 9, eventChartIndex: 10, close: 100 }),
      ],
      '4h',
    );
    inverseRuntime.analysisBarId = 2;
    inverseRuntime.bullishFvgs = [
      fvg({
        top: 90,
        bottom: 85,
        ce: 87.5,
        isActive: false,
        ifvgActive: true,
        ifvgAnalysisBirth: 1,
      }),
    ];

    processUsrFvgEvent(inverseRuntime);

    expect(inverseRuntime.bullishFvgs[0]).toMatchObject({
      ifvgActive: false,
      ifvgEndBar: 10,
      lifecycle: 'invalidated',
    });
    expect(renderUsr(inverseRuntime, 10, 100).bands[0]?.x2).toBe(10);
  });
});
