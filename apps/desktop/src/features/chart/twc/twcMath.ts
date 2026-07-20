/**
 * Math primitives for the TWC Heatmap V5 port that don't exist in
 * indicatorEngine.ts. Pine v6 semantics are mirrored where they matter
 * (warm-up nulls, na-condition-is-false ternaries, supertrend direction
 * sign). Keep in sync with TwcMath.swift.
 */

import type { TwcSource } from './twcSettings';

export interface TwcCandle {
  time: number; // epoch seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function sourceSeries(candles: TwcCandle[], source: TwcSource): number[] {
  switch (source) {
    case 'open':
      return candles.map((c) => c.open);
    case 'high':
      return candles.map((c) => c.high);
    case 'low':
      return candles.map((c) => c.low);
    case 'hl2':
      return candles.map((c) => (c.high + c.low) / 2);
    case 'hlc3':
      return candles.map((c) => (c.high + c.low + c.close) / 3);
    case 'ohlc4':
      return candles.map((c) => (c.open + c.high + c.low + c.close) / 4);
    case 'close':
    default:
      return candles.map((c) => c.close);
  }
}

/** Rolling mean over a window; null until the window fills (Pine ta.sma). */
export function rollingMean(values: (number | null)[], period: number): (number | null)[] {
  const result: (number | null)[] = values.map(() => null);
  if (period <= 0) return result;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null) {
      // Pine ta.sma propagates na through the window; restart accumulation.
      sum = 0;
      count = 0;
      continue;
    }
    sum += v;
    count++;
    if (count > period) {
      // window slides only over contiguous non-null values
      const drop = values[i - period];
      if (drop !== null) sum -= drop;
      count = period;
    }
    if (count === period) result[i] = sum / period;
  }
  return result;
}

/** Population (÷N) stdev over a window; null until it fills (Pine ta.stdev). */
export function rollingStdev(values: (number | null)[], period: number): (number | null)[] {
  const result: (number | null)[] = values.map(() => null);
  if (period <= 0) return result;
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    let valid = true;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j];
      if (v === null) {
        valid = false;
        break;
      }
      sum += v;
    }
    if (!valid) continue;
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j] as number;
      variance += (v - mean) * (v - mean);
    }
    result[i] = Math.sqrt(variance / period);
  }
  return result;
}

/** Pine f_zscore: (v - sma) / stdev, 0 when stdev == 0, null in warm-up. */
export function zscore(values: (number | null)[], period: number): (number | null)[] {
  const mean = rollingMean(values, period);
  const sd = rollingStdev(values, period);
  return values.map((v, i) => {
    const m = mean[i];
    const s = sd[i];
    if (v === null || m === null || s === null) return null;
    return s === 0 ? 0 : (v - m) / s;
  });
}

/** Gaussian PDF (Pine f_gauss). */
export function gaussPdf(x: number, mu: number, sigma: number): number {
  const s2 = sigma * sigma;
  if (s2 <= 0) return 0;
  const z = (x - mu) / sigma;
  return Math.exp(-0.5 * z * z) / (sigma * Math.sqrt(2 * Math.PI));
}

/**
 * Pine ta.linreg(src, len, offset): least-squares line fit over the last
 * `len` values, evaluated `offset` bars back from the newest point.
 */
export function linreg(values: number[], period: number, offset: number): (number | null)[] {
  const result: (number | null)[] = values.map(() => null);
  if (period <= 1) return result;
  // x = 0..period-1 (oldest..newest); precompute the constant x sums
  const n = period;
  const sumX = ((n - 1) * n) / 2;
  const sumX2 = ((n - 1) * n * (2 * n - 1)) / 6;
  for (let i = period - 1; i < values.length; i++) {
    let sumY = 0;
    let sumXY = 0;
    for (let j = 0; j < n; j++) {
      const y = values[i - period + 1 + j];
      sumY += y;
      sumXY += j * y;
    }
    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) continue;
    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    result[i] = intercept + slope * (n - 1 - offset);
  }
  return result;
}

/** Ehlers Center of Gravity (Pine f_cog, with nz() for out-of-range bars). */
export function cogSeries(values: number[], period: number): number[] {
  return values.map((_, i) => {
    let num = 0;
    let den = 0;
    for (let j = 0; j < period; j++) {
      const idx = i - j;
      const v = idx >= 0 ? values[idx] : 0; // Pine nz(s[j]) -> 0 pre-history
      num += (j + 1) * v;
      den += v;
    }
    return den === 0 ? 0 : -num / den + (period + 1) / 2;
  });
}

const NY_DAY_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Session-anchored VWAP of hlc3 (Pine ta.vwap): accumulation resets on each
 * America/New_York calendar day. On daily-and-larger intervals every bar is
 * its own session, so the VWAP collapses to that bar's hlc3 — exactly why
 * the Pine header flags the VWAP z-score as weak on D/W charts.
 */
export function sessionVwap(candles: TwcCandle[], intervalSeconds: number): (number | null)[] {
  const result: (number | null)[] = candles.map(() => null);
  const daily = intervalSeconds >= 86400;
  let pv = 0;
  let vol = 0;
  let sessionKey = '';
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (daily) {
      pv = 0;
      vol = 0;
    } else {
      const key = NY_DAY_FORMAT.format(c.time * 1000);
      if (key !== sessionKey) {
        sessionKey = key;
        pv = 0;
        vol = 0;
      }
    }
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    vol += c.volume;
    if (vol > 0) result[i] = pv / vol;
  }
  return result;
}

/**
 * Pine ta.atr: RMA of true range where the FIRST bar's true range is
 * high - low (no prior close), seeded with the SMA of the first `period`
 * true ranges, first value at index period-1. This differs from the app's
 * IndicatorEngine.atr (which skips bar 0 and outputs from index period) —
 * the TWC engine uses this one everywhere for exact Pine warm-up parity.
 */
export function pineAtr(candles: TwcCandle[], period: number): (number | null)[] {
  const result: (number | null)[] = candles.map(() => null);
  if (period <= 0 || candles.length < period) return result;
  const trueRanges = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trueRanges[i];
  let value = sum / period;
  result[period - 1] = value;
  for (let i = period; i < candles.length; i++) {
    value = (value * (period - 1) + trueRanges[i]) / period;
    result[i] = value;
  }
  return result;
}

export interface SupertrendResult {
  value: (number | null)[];
  direction: (number | null)[]; // -1 = bullish, 1 = bearish (Pine convention)
}

/** Pine ta.supertrend reference algorithm over hl2 with band ratcheting. */
export function supertrend(
  candles: TwcCandle[],
  factor: number,
  atrPeriod: number,
): SupertrendResult {
  const value: (number | null)[] = candles.map(() => null);
  const direction: (number | null)[] = candles.map(() => null);
  const atrArr = pineAtr(candles, atrPeriod);
  let prevLower: number | null = null;
  let prevUpper: number | null = null;
  let prevSt: number | null = null;
  for (let i = 0; i < candles.length; i++) {
    const a = atrArr[i];
    if (a === null) continue;
    const src = (candles[i].high + candles[i].low) / 2;
    let lower = src - factor * a;
    let upper = src + factor * a;
    const prevClose = i > 0 ? candles[i - 1].close : candles[i].close;
    if (prevLower !== null && !(lower > prevLower || prevClose < prevLower)) lower = prevLower;
    if (prevUpper !== null && !(upper < prevUpper || prevClose > prevUpper)) upper = prevUpper;

    let dir: number;
    if (i === 0 || atrArr[i - 1] === null) {
      dir = 1;
    } else if (prevSt !== null && prevUpper !== null && prevSt === prevUpper) {
      dir = candles[i].close > upper ? -1 : 1;
    } else {
      dir = candles[i].close < lower ? 1 : -1;
    }
    const st = dir === -1 ? lower : upper;
    value[i] = st;
    direction[i] = dir;
    prevLower = lower;
    prevUpper = upper;
    prevSt = st;
  }
  return { value, direction };
}

export interface HtfResample {
  htfCandles: TwcCandle[];
  /** chartToHtf[i] = index of the HTF bucket containing chart bar i. */
  chartToHtf: number[];
}

/**
 * Resample chart candles into 6x-timeframe buckets (client-side substitute
 * for Pine request.security on the 6x timeframe — the API only serves the
 * base intervals). Intraday buckets are clock-aligned; daily data buckets by
 * index blocks of 6.
 */
export function resampleHtf(candles: TwcCandle[], intervalSeconds: number): HtfResample {
  const htfCandles: TwcCandle[] = [];
  const chartToHtf: number[] = [];
  const daily = intervalSeconds >= 86400;
  const htfSeconds = intervalSeconds * 6;
  let currentKey: number | null = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const key = daily ? Math.floor(i / 6) : Math.floor(c.time / htfSeconds);
    if (key !== currentKey) {
      currentKey = key;
      htfCandles.push({ ...c });
    } else {
      const bucket = htfCandles[htfCandles.length - 1];
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
      bucket.volume += c.volume;
    }
    chartToHtf.push(htfCandles.length - 1);
  }
  return { htfCandles, chartToHtf };
}

/** Pine timeframe string → seconds ('5' → 300, 'D' → 86400, 'W' → 604800). */
export function timeframeSeconds(tf: string): number {
  if (tf === 'D' || tf === '1D') return 86400;
  if (tf === 'W' || tf === '1W') return 604800;
  const minutes = Number(tf);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : 60;
}

/**
 * Resample chart candles into arbitrary clock-aligned buckets (MTF votes).
 * Buckets no larger than the chart interval degenerate to one bucket per bar,
 * which is the best available approximation of a finer timeframe. Weekly
 * buckets anchor to the epoch week — close enough for direction votes.
 */
export function resampleTo(
  candles: TwcCandle[],
  targetSeconds: number,
  chartIntervalSeconds: number,
): HtfResample {
  if (targetSeconds <= chartIntervalSeconds) {
    return { htfCandles: candles.map((c) => ({ ...c })), chartToHtf: candles.map((_, i) => i) };
  }
  const htfCandles: TwcCandle[] = [];
  const chartToHtf: number[] = [];
  let currentKey: number | null = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const key = Math.floor(c.time / targetSeconds);
    if (key !== currentKey) {
      currentKey = key;
      htfCandles.push({ ...c });
    } else {
      const bucket = htfCandles[htfCandles.length - 1];
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
      bucket.volume += c.volume;
    }
    chartToHtf.push(htfCandles.length - 1);
  }
  return { htfCandles, chartToHtf };
}

/**
 * Map an HTF series back to chart bars repaint-safely: every chart bar in
 * bucket k reads HTF bar k-1 — the prior COMPLETED bucket — exactly what
 * Pine's f_confirmedSupertrend (expr[1] + lookahead_on) yields. Values never
 * change retroactively as the developing bucket updates.
 */
export function mapConfirmedHtf(
  htfValues: (number | null)[],
  chartToHtf: number[],
): (number | null)[] {
  return chartToHtf.map((k) => (k >= 1 ? htfValues[k - 1] : null));
}

/** crossover against a constant threshold, null-guarded (Pine ta.crossover). */
export function crossesOver(series: (number | null)[], i: number, threshold: number): boolean {
  const cur = series[i];
  const prev = i > 0 ? series[i - 1] : null;
  return cur !== null && prev !== null && cur > threshold && prev <= threshold;
}

export function crossesUnder(series: (number | null)[], i: number, threshold: number): boolean {
  const cur = series[i];
  const prev = i > 0 ? series[i - 1] : null;
  return cur !== null && prev !== null && cur < threshold && prev >= threshold;
}

/** Series-vs-series crossover at index i, null-guarded. */
export function seriesCrossOver(a: (number | null)[], b: (number | null)[], i: number): boolean {
  if (i <= 0) return false;
  const a0 = a[i - 1];
  const a1 = a[i];
  const b0 = b[i - 1];
  const b1 = b[i];
  return a0 !== null && a1 !== null && b0 !== null && b1 !== null && a1 > b1 && a0 <= b0;
}

export function seriesCrossUnder(a: (number | null)[], b: (number | null)[], i: number): boolean {
  if (i <= 0) return false;
  const a0 = a[i - 1];
  const a1 = a[i];
  const b0 = b[i - 1];
  const b1 = b[i];
  return a0 !== null && a1 !== null && b0 !== null && b1 !== null && a1 < b1 && a0 >= b0;
}

/**
 * Pine ta.pivothigh(src, left, right): confirmed at bar i, the pivot sits at
 * i - right and must exceed every bar `left` back and `right` forward
 * (>= on the left so flat tops resolve at their earliest bar, > on the right).
 * Returns the pivot PRICE at confirmation bars, null elsewhere.
 */
export function pivotHigh(values: number[], left: number, right: number): (number | null)[] {
  const result: (number | null)[] = values.map(() => null);
  for (let i = left + right; i < values.length; i++) {
    const center = i - right;
    const pivot = values[center];
    let ok = true;
    for (let j = center - left; j < center; j++) {
      if (values[j] > pivot) {
        ok = false;
        break;
      }
    }
    if (ok) {
      for (let j = center + 1; j <= center + right; j++) {
        if (values[j] >= pivot) {
          ok = false;
          break;
        }
      }
    }
    if (ok) result[i] = pivot;
  }
  return result;
}

export function pivotLow(values: number[], left: number, right: number): (number | null)[] {
  const result: (number | null)[] = values.map(() => null);
  for (let i = left + right; i < values.length; i++) {
    const center = i - right;
    const pivot = values[center];
    let ok = true;
    for (let j = center - left; j < center; j++) {
      if (values[j] < pivot) {
        ok = false;
        break;
      }
    }
    if (ok) {
      for (let j = center + 1; j <= center + right; j++) {
        if (values[j] <= pivot) {
          ok = false;
          break;
        }
      }
    }
    if (ok) result[i] = pivot;
  }
  return result;
}

/**
 * Pine ta.highestbars(src, len) at bar i: offset (0 or negative) to the
 * highest value of the last `len` bars; most recent bar wins ties.
 */
export function highestBarsOffset(values: number[], i: number, length: number): number {
  const start = Math.max(0, i - length + 1);
  let best = start;
  for (let j = start + 1; j <= i; j++) {
    if (values[j] >= values[best]) best = j;
  }
  return best - i;
}

export function lowestBarsOffset(values: number[], i: number, length: number): number {
  const start = Math.max(0, i - length + 1);
  let best = start;
  for (let j = start + 1; j <= i; j++) {
    if (values[j] <= values[best]) best = j;
  }
  return best - i;
}
