import { describe, expect, it } from 'vitest';
import { computeUsr } from './computeUsr';
import { DEFAULT_USR_SETTINGS, validateUsrSettings } from './usrSettings';
import type { UsrCandle } from './usrTypes';

function history(start = 1_700_000_000): UsrCandle[] {
  return Array.from({ length: 24 }, (_, index) => {
    const center = index === 12 ? 90 : 100 + Math.sin(index / 2);
    return {
      time: start + index * 60,
      open: center,
      high: center + 2,
      low: center - 2,
      close: center + 1,
      volume: index === 12 ? 300 : 100,
    };
  });
}

function settings() {
  return {
    ...DEFAULT_USR_SETTINGS,
    enabled: true,
    volumeLookback: 10,
    minimumRelativeVolume: 1,
    minimumVolumeZScore: 0,
    pivotLeftBars: 3,
    pivotRightBars: 1,
  };
}

describe('Ultimate Support & Resistance causal engine', () => {
  it('rejects malformed settings instead of running an ambiguous model', () => {
    expect(() => validateUsrSettings({ ...settings(), minimumTick: 0 })).toThrow();
    expect(() => validateUsrSettings({ ...settings(), unknown: true })).toThrow();
    expect(() => validateUsrSettings({ ...settings(), customTimeframe: '2H' })).toThrow();
    expect(validateUsrSettings({ ...settings(), customTimeframe: '2W' }).customTimeframe).toBe(
      '2W',
    );
  });

  it('detects a confirmed volume pivot and is deterministic', () => {
    const candles = history();
    const context = { chartIntervalSeconds: 60, now: candles.at(-1)!.time + 120 };
    const first = computeUsr(candles, settings(), context)!;
    const second = computeUsr(candles, settings(), context)!;
    expect(first.supportZones.some((zone) => zone.isLine && zone.startBar === 12)).toBe(true);
    expect(second).toEqual(first);
  });

  it('does not let the open realtime candle change confirmed model state', () => {
    const closed = history();
    const now = closed.at(-1)!.time + 90;
    const live: UsrCandle = {
      time: now - 30,
      open: 100,
      high: 150,
      low: 50,
      close: 55,
      volume: 1_000_000,
    };
    const base = computeUsr(closed, settings(), { chartIntervalSeconds: 60, now })!;
    const withLive = computeUsr([...closed, live], settings(), { chartIntervalSeconds: 60, now })!;
    expect(withLive.supportZones).toEqual(base.supportZones);
    expect(withLive.resistanceZones).toEqual(base.resistanceZones);
    expect(withLive.signals).toEqual(base.signals);
    expect(withLive.diagnostics.confirmedChartBars).toBe(closed.length);
  });

  it('extends rendering to the open right-edge candle without consuming it analytically', () => {
    const closed = history();
    const now = closed.at(-1)!.time + 90;
    const live: UsrCandle = {
      time: now - 30,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
    };
    const renderSettings = { ...settings(), enableProximityFilter: false };
    const base = computeUsr(closed, renderSettings, { chartIntervalSeconds: 60, now })!;
    const withLive = computeUsr([...closed, live], renderSettings, {
      chartIntervalSeconds: 60,
      now,
    })!;
    expect(base.renderModel.segments.length).toBeGreaterThan(0);
    expect(withLive.renderModel.segments[0].x2).toBe(base.renderModel.segments[0].x2 + 1);
    expect(withLive.supportZones).toEqual(base.supportZones);
  });

  it('keeps proximity strictly render-only', () => {
    const candles = history();
    const context = { chartIntervalSeconds: 60, now: candles.at(-1)!.time + 120 };
    const filtered = computeUsr(
      candles,
      { ...settings(), enableProximityFilter: true, proximityPercent: 1 },
      context,
    )!;
    const unfiltered = computeUsr(
      candles,
      { ...settings(), enableProximityFilter: false },
      context,
    )!;
    expect(filtered.supportZones).toEqual(unfiltered.supportZones);
    expect(filtered.resistanceZones).toEqual(unfiltered.resistanceZones);
    expect(filtered.signals).toEqual(unfiltered.signals);
  });

  it('publishes an HTF candle only after the next HTF bucket begins', () => {
    const start = 1_699_920_000; // UTC bucket boundary
    const candles = Array.from({ length: 720 }, (_, index): UsrCandle => ({
      time: start + index * 60,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
    }));
    const result = computeUsr(
      candles,
      { ...settings(), analysisTimeframe: '4h' },
      {
        chartIntervalSeconds: 60,
        now: candles.at(-1)!.time + 120,
      },
    )!;
    expect(result.diagnostics.usedChartTimeframe).toBe(false);
    expect(result.diagnostics.analysisBars).toBe(2);
  });

  it('anchors HTF structural origins at the source candle end without backpainting', () => {
    const start = 1_699_920_000;
    const candles = Array.from({ length: 52 }, (_, index): UsrCandle => {
      const group = Math.floor(index / 4);
      const center = group === 10 ? 90 : 100;
      return {
        time: start + index * 3_600,
        open: center,
        high: center + 2,
        low: center - 2,
        close: center + 1,
        volume: group === 10 ? 300 : 100,
      };
    });
    const result = computeUsr(
      candles,
      { ...settings(), analysisTimeframe: '4h' },
      { chartIntervalSeconds: 3_600, now: candles.at(-1)!.time + 7_200 },
    )!;
    const pivot = result.supportZones.find(
      (zone) => zone.isLine && zone.top === 90 && zone.bottom === 90,
    );
    expect(pivot?.startBar).toBe(43);
    expect(pivot?.activationBar).toBe(48);
  });

  it('uses Pine calendar-month buckets for weekly Auto analysis', () => {
    const start = Date.UTC(2026, 0, 5) / 1_000;
    const candles = Array.from({ length: 10 }, (_, index): UsrCandle => ({
      time: start + index * 7 * 86_400,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
    }));
    const result = computeUsr(
      candles,
      { ...settings(), analysisTimeframe: 'auto' },
      { chartIntervalSeconds: 7 * 86_400, now: candles.at(-1)!.time + 8 * 86_400 },
    )!;
    expect(result.diagnostics.analysisTimeframeTag).toBe('1M');
    expect(result.diagnostics.analysisBars).toBe(2);
  });

  it('keeps equal-duration Pine clocks distinct', () => {
    const candles = Array.from({ length: 5 }, (_, index): UsrCandle => ({
      time: 1_700_006_400 + index * 86_400,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
    }));
    const result = computeUsr(
      candles,
      { ...settings(), analysisTimeframe: 'custom', customTimeframe: '1440' },
      { chartIntervalSeconds: 86_400, now: candles.at(-1)!.time + 2 * 86_400 },
    )!;
    expect(result.diagnostics.usedChartTimeframe).toBe(false);
    expect(result.diagnostics.analysisBars).toBe(4);
  });

  it('retains every completed tick candle when no open candle is in the chart array', () => {
    const candles = history();
    const result = computeUsr(candles, settings(), {
      chartIntervalSeconds: null,
      now: candles.at(-1)!.time,
      lastCandleIsOpen: false,
    })!;
    expect(result.diagnostics.confirmedChartBars).toBe(candles.length);
    expect(result.diagnostics.analysisBars).toBe(candles.length);
  });

  it('does not read future follow-through when a volume sequence is force-chunked', () => {
    const candles = Array.from({ length: 18 }, (_, index): UsrCandle => ({
      time: 1_700_000_000 + index * 60,
      open: 99,
      high: 101,
      low: 98,
      close: 100,
      volume: 100,
    }));
    candles[14] = { ...candles[14], open: 100, high: 101, low: 98, close: 99, volume: 300 };
    candles[15] = { ...candles[15], open: 99, high: 110.5, low: 98.5, close: 110, volume: 300 };
    candles[16] = { ...candles[16], open: 107, high: 109, low: 106, close: 108, volume: 100 };
    const result = computeUsr(
      candles,
      {
        ...settings(),
        maxSequenceLength: 2,
        structureLookback: 2,
        displacementAtrMultiplier: 0.2,
      },
      { chartIntervalSeconds: 60, now: candles.at(-1)!.time + 120 },
    )!;
    const orderBlock = result.supportZones.find(
      (zone) => zone.startBar === 14 && zone.top === 100 && zone.bottom === 99,
    );
    expect(orderBlock?.analysisBirth).toBe(16);
  });

  it('matches Pine queued source identities and reverse same-side commit order', () => {
    const candles = Array.from({ length: 16 }, (_, index): UsrCandle => ({
      time: 1_700_000_000 + index * 60,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
    }));
    candles[12] = {
      ...candles[12],
      open: 110,
      high: 111,
      low: 109,
      close: 110.5,
      volume: 300,
    };
    candles[13] = {
      ...candles[13],
      open: 120,
      high: 121,
      low: 119,
      close: 120.5,
      volume: 300,
    };
    candles[14] = { ...candles[14], open: 120, high: 121, low: 119, close: 120 };
    candles[15] = { ...candles[15], open: 120, high: 121, low: 119, close: 120 };

    const result = computeUsr(
      candles,
      {
        ...settings(),
        minimumRelativeVolume: 2,
        minimumVolumeZScore: 0.5,
        pivotRightBars: 5,
        requirePriceVoidGaps: true,
        showFvg: false,
      },
      { chartIntervalSeconds: 60, now: candles.at(-1)!.time + 120 },
    )!;
    const gaps = result.supportZones.filter(
      (zone) => !zone.isLine && (zone.startBar === 12 || zone.startBar === 13),
    );
    expect(gaps.map((zone) => zone.startBar)).toEqual([12, 13]);
    expect(gaps.map((zone) => zone.sourceId)).toEqual([2, 1]);
    expect(gaps.map((zone) => zone.id)).toEqual([3, 4]);
  });

  it('uses Pine chart ATR fallback during Wilder warm-up', () => {
    const candles = Array.from({ length: 8 }, (_, index): UsrCandle => ({
      time: 1_700_000_000 + index * 60,
      open: 100,
      high: 100.6,
      low: 99.6,
      close: 100.2,
      volume: 100,
    }));
    candles[2] = { ...candles[2], high: 101, low: 99 };
    candles[3] = { ...candles[3], open: 101, high: 106.1, low: 100.9, close: 106 };
    candles[4] = { ...candles[4], open: 103, high: 104, low: 102, close: 103.5 };
    const result = computeUsr(
      candles,
      {
        ...settings(),
        fvgLookback: 3,
        fvgBodyPercent: 0.05,
        fvgMinBodyAtr: 0,
        fvgMinGapAtr: 0,
      },
      { chartIntervalSeconds: 60, now: candles.at(-1)!.time + 120 },
    )!;
    expect(result.bullishFvgs).toHaveLength(1);
  });

  it('uses the configured tick buffer for FVG close milestones', () => {
    const candles = Array.from({ length: 6 }, (_, index): UsrCandle => ({
      time: 1_700_000_000 + index * 60,
      open: 100,
      high: 100.6,
      low: 99.6,
      close: 100.2,
      volume: 100,
    }));
    candles[2] = { ...candles[2], high: 101, low: 99 };
    candles[3] = { ...candles[3], open: 101, high: 106.1, low: 100.9, close: 106 };
    candles[4] = { ...candles[4], open: 103, high: 104, low: 102, close: 103.5 };
    candles[5] = { ...candles[5], open: 102.03, high: 102.2, low: 102.02, close: 102.04 };
    const base = {
      ...settings(),
      fvgFillMode: 'close' as const,
      fvgLookback: 3,
      fvgBodyPercent: 0.05,
      fvgMinBodyAtr: 0,
      fvgMinGapAtr: 0,
    };
    const context = { chartIntervalSeconds: 60, now: candles.at(-1)!.time + 120 };
    const oneTick = computeUsr(candles, { ...base, breakBufferTicks: 1 }, context)!;
    const fiveTicks = computeUsr(candles, { ...base, breakBufferTicks: 5 }, context)!;
    expect(oneTick.bullishFvgs[0].milestoneReached).toBe(false);
    expect(fiveTicks.bullishFvgs[0].milestoneReached).toBe(true);
  });

  it('keeps seeded stress histories deterministic, finite, unique, and within every cap', () => {
    let seed = 0x5eed_1234;
    const random = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    let priorClose = 100;
    const candles = Array.from({ length: 720 }, (_, index): UsrCandle => {
      const open = priorClose;
      const close = Math.max(5, open + (random() - 0.49) * 2.5);
      const high = Math.max(open, close) + random() * 1.2;
      const low = Math.min(open, close) - random() * 1.2;
      priorClose = close;
      return {
        time: 1_700_000_000 + index * 60,
        open,
        high,
        low,
        close,
        volume: 80 + random() * 40 + (index % 17 === 0 ? 500 : 0),
      };
    });
    const context = { chartIntervalSeconds: 60, now: candles.at(-1)!.time + 120 };

    for (const analysisTimeframe of ['chart', 'auto'] as const) {
      const stressSettings = {
        ...settings(),
        analysisTimeframe,
        showConfluence: true,
        showBounceSignals: true,
        showSweepSignals: true,
        maxSequenceLength: 6,
        maxSupportLevels: 40,
        maxResistanceLevels: 35,
        maxSupportPools: 8,
        maxResistancePools: 7,
        maxVisibleFvgs: 3,
        fvgMaxBarsActive: 30,
      };
      const first = computeUsr(candles, stressSettings, context)!;
      const second = computeUsr(candles, stressSettings, context)!;
      expect(second).toEqual(first);

      const zones = [...first.supportZones, ...first.resistanceZones];
      expect(new Set(zones.map(({ id }) => id)).size).toBe(zones.length);
      expect(first.supportZones.length + first.resistanceZones.length).toBeLessThanOrEqual(75);
      expect(first.supportPools.length).toBeLessThanOrEqual(stressSettings.maxSupportPools);
      expect(first.resistancePools.length).toBeLessThanOrEqual(stressSettings.maxResistancePools);
      expect(
        first.bullishFvgs.filter(({ visualVisible }) => visualVisible).length,
      ).toBeLessThanOrEqual(stressSettings.maxVisibleFvgs);
      expect(
        first.bearishFvgs.filter(({ visualVisible }) => visualVisible).length,
      ).toBeLessThanOrEqual(stressSettings.maxVisibleFvgs);

      const zoneById = new Map(zones.map((zone) => [zone.id, zone]));
      for (const pool of [...first.supportPools, ...first.resistancePools]) {
        expect(pool.memberIds.length).toBeGreaterThanOrEqual(stressSettings.poolClusterThreshold);
        for (const id of pool.memberIds) {
          expect(zoneById.get(id)).toMatchObject({ inPool: true, poolId: pool.id });
        }
      }

      const signalKeys = first.signals.map(
        (signal) => `${signal.analysisBarId}|${signal.kind}|${signal.source}|${signal.sourceKey}`,
      );
      expect(new Set(signalKeys).size).toBe(signalKeys.length);
      expect(
        first.signals.every(
          (signal) =>
            signal.chartBarIndex >= 0 &&
            signal.chartBarIndex < first.diagnostics.confirmedChartBars,
        ),
      ).toBe(true);

      const geometry = first.renderModel;
      const coordinates = [
        ...geometry.segments.flatMap(({ x1, y1, x2, y2, width }) => [x1, y1, x2, y2, width]),
        ...geometry.bands.flatMap(({ x1, x2, yTop, yBottom, borderWidth = 1 }) => [
          x1,
          x2,
          yTop,
          yBottom,
          borderWidth,
        ]),
        ...geometry.labels.flatMap(({ barIndex, price }) => [barIndex, price]),
        ...geometry.markers.map(({ barIndex }) => barIndex),
      ];
      expect(coordinates.every(Number.isFinite)).toBe(true);
      expect(geometry.bands.every(({ yTop, yBottom }) => yTop >= yBottom)).toBe(true);
    }
  });
});
