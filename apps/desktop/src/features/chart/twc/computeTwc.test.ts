import { describe, expect, it } from 'vitest';
import { DEFAULT_TWC_SETTINGS, type TwcHeatmapSettings } from './twcSettings';
import {
  mapConfirmedHtf,
  resampleHtf,
  resampleTo,
  sessionVwap,
  supertrend,
  timeframeSeconds,
  type TwcCandle,
} from './twcMath';
import { computeTwc } from './computeTwc';
import { computeFib, fibDirectionSeries } from './twcFib';
import { computeSmc } from './twcSmc';
import { pineAtr } from './twcMath';

const MINUTE = 60;

// Base time divisible by 360 so 1m bars align cleanly with 6-minute HTF buckets
const BASE_TIME = 1_699_999_920;

function candle(
  i: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 1000,
): TwcCandle {
  return { time: BASE_TIME + i * MINUTE, open, high, low, close, volume };
}

/** Simple trending series: close climbs `step` per bar with a small range. */
function trend(count: number, start: number, step: number): TwcCandle[] {
  const candles: TwcCandle[] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const open = price;
    price += step;
    const close = price;
    candles.push(candle(i, open, Math.max(open, close) + 0.2, Math.min(open, close) - 0.2, close));
  }
  return candles;
}

/** V shape: down `downBars`, then up `upBars`, fixed step. */
function vShape(downBars: number, upBars: number, start: number, step: number): TwcCandle[] {
  const candles: TwcCandle[] = [];
  let price = start;
  for (let i = 0; i < downBars + upBars; i++) {
    const open = price;
    price += i < downBars ? -step : step;
    const close = price;
    candles.push(candle(i, open, Math.max(open, close) + 0.1, Math.min(open, close) - 0.1, close));
  }
  return candles;
}

const settings = (patch: Partial<TwcHeatmapSettings> = {}): TwcHeatmapSettings => ({
  ...DEFAULT_TWC_SETTINGS,
  enabled: true,
  ...patch,
});

describe('supertrend', () => {
  it('is bullish (direction -1) with value below price in a sustained uptrend', () => {
    const candles = trend(80, 100, 1);
    const st = supertrend(candles, 3.5, 14);
    const last = candles.length - 1;
    expect(st.direction[last]).toBe(-1);
    expect(st.value[last]).not.toBeNull();
    expect(st.value[last]!).toBeLessThan(candles[last].close);
  });

  it('is bearish (direction 1) with value above price in a sustained downtrend', () => {
    const candles = trend(80, 200, -1);
    const st = supertrend(candles, 3.5, 14);
    const last = candles.length - 1;
    expect(st.direction[last]).toBe(1);
    expect(st.value[last]!).toBeGreaterThan(candles[last].close);
  });

  it('flips direction after a strong reversal', () => {
    const candles = vShape(60, 60, 200, 1);
    const st = supertrend(candles, 2, 10);
    expect(st.direction[55]).toBe(1); // downtrend
    expect(st.direction[candles.length - 1]).toBe(-1); // recovered uptrend
  });

  it('returns nulls during ATR warm-up', () => {
    const candles = trend(20, 100, 1);
    const st = supertrend(candles, 3.5, 14);
    expect(st.value[5]).toBeNull();
    expect(st.direction[5]).toBeNull();
  });
});

describe('HTF resample + confirmed mapping', () => {
  it('buckets 6 chart bars per HTF bar with OHLCV aggregation', () => {
    const candles = trend(36, 100, 1);
    const { htfCandles, chartToHtf } = resampleHtf(candles, MINUTE);
    expect(htfCandles.length).toBe(6);
    expect(chartToHtf[0]).toBe(0);
    expect(chartToHtf[5]).toBe(0);
    expect(chartToHtf[6]).toBe(1);
    const bucket = htfCandles[0];
    expect(bucket.open).toBe(candles[0].open);
    expect(bucket.close).toBe(candles[5].close);
    expect(bucket.high).toBe(Math.max(...candles.slice(0, 6).map((c) => c.high)));
    expect(bucket.volume).toBe(candles.slice(0, 6).reduce((s, c) => s + c.volume, 0));
  });

  it('maps chart bars to the PRIOR completed HTF bar (repaint-safe)', () => {
    const candles = trend(36, 100, 1);
    const { htfCandles, chartToHtf } = resampleHtf(candles, MINUTE);
    const htfValues = htfCandles.map((_, k) => k * 10); // sentinel per bucket
    const mapped = mapConfirmedHtf(htfValues, chartToHtf);
    // First bucket has no prior completed bucket
    for (let i = 0; i < 6; i++) expect(mapped[i]).toBeNull();
    // Bars of bucket k read bucket k-1, constant within the bucket
    for (let i = 6; i < 12; i++) expect(mapped[i]).toBe(0);
    for (let i = 12; i < 18; i++) expect(mapped[i]).toBe(10);
    // Appending a bar to the developing bucket never changes earlier values
    const more = trend(37, 100, 1);
    const r2 = resampleHtf(more, MINUTE);
    const mapped2 = mapConfirmedHtf(
      r2.htfCandles.map((_, k) => k * 10),
      r2.chartToHtf,
    );
    for (let i = 0; i < 36; i++) expect(mapped2[i]).toBe(mapped[i]);
  });
});

/**
 * Alternating legs long enough for BOTH the fib zigzag (10/10 pivots) and the
 * SMC swing structure (34-bar legs) to confirm pivots on each side:
 * 300 → 240 → 320 → 280 → 430. The final rally breaks the swing high
 * (structure BOS → order block) and unlocks fib extensions.
 */
function zigzagFixture(): TwcCandle[] {
  const out: TwcCandle[] = [];
  let price = 300;
  let i = 0;
  const leg = (bars: number, step: number): void => {
    for (let k = 0; k < bars; k++) {
      const open = price;
      price += step;
      out.push(candle(i++, open, Math.max(open, price) + 0.1, Math.min(open, price) - 0.1, price));
    }
  };
  leg(60, -1);
  leg(80, 1);
  leg(40, -1);
  leg(150, 1);
  return out;
}

describe('fib zigzag engine', () => {
  const candles = zigzagFixture();
  const atr14 = pineAtr(candles, 14);

  it('draws the seed fib levels for the detected swing', () => {
    const fib = computeFib(candles, settings(), atr14);
    // seed ratios: -0.618, 0, 0.618, 0.786(2), 1.0 (+1.618/1.786 via alwaysShowFirst)
    expect(fib.segments.length).toBeGreaterThanOrEqual(5);
  });

  it('pre-reveals the 1.618/1.786 band with a Profit Target #1 label when ptAlwaysShowFirst is on', () => {
    const fib = computeFib(candles, settings({ ptAlwaysShowFirst: true }), atr14);
    expect(fib.bands.length).toBeGreaterThanOrEqual(1);
    expect(fib.labels.some((l) => l.text === 'Profit Target #1')).toBe(true);
  });

  it('emits no PT labels or geometry before a swing has formed', () => {
    // A single trend never confirms two pivots -> no swing, nothing drawn
    const flat = vShape(30, 12, 300, 1);
    for (let i = 0; i < 30; i++) {
      const last = flat[flat.length - 1];
      flat.push(candle(flat.length, last.close, last.close + 0.1, last.close - 0.1, last.close));
    }
    const fib = computeFib(flat, settings({ ptAlwaysShowFirst: false }), pineAtr(flat, 14));
    expect(fib.segments).toHaveLength(0);
    expect(fib.labels.some((l) => l.text.startsWith('Profit Target'))).toBe(false);
  });

  it('emits stacked Gann squares only for unlocked extension ranges', () => {
    const withGann = settings({ showGannFan: true, showGannBox: true, gann1x1: true });
    const fib = computeFib(candles, withGann, atr14);
    const dashed = fib.segments.filter((s) => s.style === 'dashed');
    // at least one square frame (4 dashed edges per square)
    expect(dashed.length % 4).toBe(0);
    expect(dashed.length).toBeGreaterThanOrEqual(4);
    const dotted = fib.segments.filter((s) => s.style === 'dotted');
    expect(dotted.length).toBeGreaterThanOrEqual(4); // 4 corners x 1 angle x squares
  });

  it('never renders the 0.618–0.786 retracement band (Pine key-mismatch parity)', () => {
    // Up swing 240 -> 320, then a gap-down retrace through the 0.618 level
    // (289.4) WITHOUT ever revisiting fib 1 — TradingView draws no band here
    // because the Pine script's band-0 line lookup silently fails.
    const fixture: TwcCandle[] = [];
    let price = 300;
    let i = 0;
    const leg = (bars: number, step: number): void => {
      for (let k = 0; k < bars; k++) {
        const open = price;
        price += step;
        fixture.push(
          candle(i++, open, Math.max(open, price) + 0.1, Math.min(open, price) - 0.1, price),
        );
      }
    };
    leg(60, -1); // 300 -> 240 (pivot low)
    leg(80, 1); // -> 320 (pivot high)
    // gap-down retrace: highs stay far below fib 1 (320)
    price = 310;
    for (let k = 0; k < 30; k++) {
      const open = price;
      price -= 1;
      fixture.push(candle(i++, open, open + 0.1, price - 0.1, price));
    }
    const fib = computeFib(fixture, settings({ ptAlwaysShowFirst: false }), pineAtr(fixture, 14));
    expect(fib.bands).toHaveLength(0);
    expect(fib.labels.some((l) => l.text.startsWith('Profit Target'))).toBe(false);
  });

  it('returns nothing when the fib engine is disabled', () => {
    const fib = computeFib(candles, settings({ showFibonacci: false }), atr14);
    expect(fib.segments).toHaveLength(0);
    expect(fib.bands).toHaveLength(0);
    expect(fib.labels).toHaveLength(0);
  });
});

describe('SMC engine', () => {
  const candles = zigzagFixture();

  it('draws premium/discount/equilibrium zones with labels', () => {
    const smc = computeSmc(
      candles,
      settings({ showPremiumDiscountZones: true, showSwingOrderBlocks: false }),
    );
    const zoneLabels = smc.labels.map((l) => l.text);
    expect(zoneLabels).toContain('Premium');
    expect(zoneLabels).toContain('Equilibrium');
    expect(zoneLabels).toContain('Discount');
    expect(smc.bands.length).toBe(3);
    // Zones tile top→bottom without inversion
    const [premium, , discount] = smc.bands;
    expect(premium.yTop).toBeGreaterThan(discount.yBottom);
  });

  it('stores swing order blocks on structure breaks and caps the visible count', () => {
    const smc = computeSmc(
      candles,
      settings({
        showSwingOrderBlocks: true,
        swingOrderBlocksSize: 4,
        showPremiumDiscountZones: false,
      }),
    );
    // The long final leg breaks the swing high -> at least one bullish block
    expect(smc.bands.length).toBeGreaterThanOrEqual(1);
    expect(smc.bands.length).toBeLessThanOrEqual(4);
    for (const band of smc.bands) expect(band.borderColor).toBeDefined();
  });

  it('publishes per-bar structure bias for the confluence engine', () => {
    const smc = computeSmc(
      candles,
      settings({ showSwingOrderBlocks: false, showPremiumDiscountZones: false }),
    );
    expect(smc.swingBias.length).toBe(candles.length);
    // The sustained final rally flips the swing bias bullish
    expect(smc.swingBias[candles.length - 1]).toBe(1);
  });
});

describe('confluence engine', () => {
  const candles = zigzagFixture();

  it('maps timeframe strings to seconds', () => {
    expect(timeframeSeconds('5')).toBe(300);
    expect(timeframeSeconds('240')).toBe(14400);
    expect(timeframeSeconds('D')).toBe(86400);
    expect(timeframeSeconds('W')).toBe(604800);
  });

  it('resampleTo degenerates to identity for finer-or-equal timeframes', () => {
    const { htfCandles, chartToHtf } = resampleTo(candles, 60, 60);
    expect(htfCandles.length).toBe(candles.length);
    expect(chartToHtf[10]).toBe(10);
  });

  it('fibDirectionSeries turns bullish during the final rally', () => {
    const dir = fibDirectionSeries(candles, settings());
    expect(dir[candles.length - 1]).toBe(1);
    expect(dir[0]).toBe(0); // no swing yet
  });

  it('emits CL/CS pill markers only when enabled', () => {
    const off = computeTwc(candles, settings({ showConfMarkers: false }), MINUTE)!;
    expect(off.markers.some((m) => m.text === 'CL' || m.text === 'CS')).toBe(false);
    // With the gate off, CL/CS mirror the ST-gated signals — assert no crash
    // and pill-only markers when enabled (signals may or may not fire here).
    const on = computeTwc(
      candles,
      settings({ showConfMarkers: true, useConfluenceGate: false }),
      MINUTE,
    )!;
    for (const m of on.markers.filter((mk) => mk.text === 'CL' || mk.text === 'CS')) {
      expect(['labelUp', 'labelDown']).toContain(m.shape);
    }
  });
});

describe('session VWAP', () => {
  it('collapses to per-bar hlc3 on daily intervals (each bar is its own session)', () => {
    const candles = trend(20, 100, 1);
    const vw = sessionVwap(candles, 86400);
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      expect(vw[i]).toBeCloseTo((c.high + c.low + c.close) / 3, 10);
    }
  });

  it('accumulates within the session on intraday intervals', () => {
    const candles = trend(20, 100, 1);
    const vw = sessionVwap(candles, 60);
    // cumulative VWAP lags the rising per-bar typical price
    const last = candles[candles.length - 1];
    expect(vw[candles.length - 1]!).toBeLessThan((last.high + last.low + last.close) / 3);
  });
});

describe('VWAP rip', () => {
  it('marks the first bar |z| crosses the stretch threshold', () => {
    // Flat then a violent spike: z-score jumps past the threshold once
    const candles: TwcCandle[] = [];
    for (let i = 0; i < 80; i++) {
      const wiggle = (i % 2 === 0 ? 1 : -1) * 0.3;
      candles.push(candle(i, 100 + wiggle, 100.6 + wiggle, 99.4 + wiggle, 100 - wiggle));
    }
    for (let i = 80; i < 90; i++) {
      const price = 100 + (i - 79) * 3;
      candles.push(candle(i, price - 3, price + 0.5, price - 3.5, price));
    }
    const model = computeTwc(candles, settings({ showVwapRip: true, vwapWarn: 1.5 }), MINUTE)!;
    const rips = model.markers.filter((m) => m.text === 'RIP');
    expect(rips.length).toBeGreaterThanOrEqual(1);
    expect(rips[0].placement).toBe('aboveBar'); // stretched upward
    const off = computeTwc(candles, settings({ showVwapRip: false }), MINUTE)!;
    expect(off.markers.some((m) => m.text === 'RIP')).toBe(false);
  });
});

describe('computeTwc', () => {
  const candles = vShape(60, 200, 300, 1);

  it('returns null when disabled or without candles', () => {
    expect(computeTwc(candles, { ...DEFAULT_TWC_SETTINGS, enabled: false }, MINUTE)).toBeNull();
    expect(computeTwc([], settings(), MINUTE)).toBeNull();
  });

  it('produces regime candle colors only when colorBars is on', () => {
    const off = computeTwc(candles, settings({ colorBars: false }), MINUTE)!;
    expect(off.candleColors).toBeNull();
    const on = computeTwc(candles, settings({ colorBars: true }), MINUTE)!;
    expect(on.candleColors).not.toBeNull();
    expect(on.candleColors!.length).toBe(candles.length);
    expect(on.candleColors!.some((c) => c !== null)).toBe(true);
  });

  it('emits CTF supertrend line series split by direction', () => {
    const model = computeTwc(candles, settings(), MINUTE)!;
    const bull = model.lines.find((l) => l.id === 'ctfBull')!;
    const bear = model.lines.find((l) => l.id === 'ctfBear')!;
    expect(bull).toBeDefined();
    expect(bear).toBeDefined();
    // A bar is never in both
    for (let i = 0; i < candles.length; i++) {
      expect(bull.values[i] !== null && bear.values[i] !== null).toBe(false);
    }
    // The long uptrend tail is bullish
    expect(bull.values[candles.length - 1]).not.toBeNull();
  });

  it('shows a bias banner with one of the three configured texts', () => {
    const model = computeTwc(candles, settings(), MINUTE)!;
    expect(model.banner).not.toBeNull();
    expect([
      DEFAULT_TWC_SETTINGS.biasLongText,
      DEFAULT_TWC_SETTINGS.biasShortText,
      DEFAULT_TWC_SETTINGS.biasChopText,
    ]).toContain(model.banner!.text);
  });

  it('respects showMarkers for diamonds/triangles', () => {
    const model = computeTwc(
      candles,
      settings({ showMarkers: false, showMacdAlign: false }),
      MINUTE,
    )!;
    expect(model.markers.filter((m) => m.shape === 'diamond')).toHaveLength(0);
  });
});
