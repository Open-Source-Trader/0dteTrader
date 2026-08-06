/**
 * Pure indicator math over candles (IndicatorEngine.swift port, 1:1 including
 * the MACD signal-over-compacted-points behavior). Every function returns an
 * array aligned with the input; warm-up indices are `null`.
 */

import type {
  IndicatorDescriptor,
  IndicatorGeometry,
  IndicatorId,
  OrderBookIndicators,
} from '@0dtetrader/shared-types';

export interface CandleInput {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TimedCandleInput extends CandleInput {
  timestamp: number;
}

export interface MACDValues {
  macdLine: (number | null)[];
  signalLine: (number | null)[];
  histogram: (number | null)[];
}

export interface BollingerBandsValues {
  upper: (number | null)[];
  middle: (number | null)[];
  lower: (number | null)[];
}

export function sma(values: number[], period: number): (number | null)[] {
  if (period <= 0 || values.length < period) {
    return values.map(() => null);
  }
  const result: (number | null)[] = values.map(() => null);
  let windowSum = 0;
  for (let i = 0; i < period; i++) windowSum += values[i];
  result[period - 1] = windowSum / period;
  for (let i = period; i < values.length; i++) {
    windowSum += values[i] - values[i - period];
    result[i] = windowSum / period;
  }
  return result;
}

// Seeded with the SMA of the first `period` values, then k = 2/(period+1).
export function ema(values: number[], period: number): (number | null)[] {
  if (period <= 0 || values.length < period) {
    return values.map(() => null);
  }
  const result: (number | null)[] = values.map(() => null);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed /= period;
  result[period - 1] = seed;
  const multiplier = 2 / (period + 1);
  let previous = seed;
  for (let i = period; i < values.length; i++) {
    const value = values[i] * multiplier + previous * (1 - multiplier);
    result[i] = value;
    previous = value;
  }
  return result;
}

export function vwap(candles: CandleInput[]): (number | null)[] {
  const result: (number | null)[] = candles.map(() => null);
  let cumulativePV = 0;
  let cumulativeVolume = 0;
  candles.forEach((candle, index) => {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    cumulativePV += typicalPrice * candle.volume;
    cumulativeVolume += candle.volume;
    if (cumulativeVolume > 0) {
      result[index] = cumulativePV / cumulativeVolume;
    }
  });
  return result;
}

export function rsi(candles: CandleInput[], period = 14): (number | null)[] {
  const closes = candles.map((c) => c.close);
  if (period <= 0 || closes.length <= period) {
    return closes.map(() => null);
  }
  const result: (number | null)[] = closes.map(() => null);

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += -change;
  }
  avgGain /= period;
  avgLoss /= period;
  result[period] = rsiValue(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[i] = rsiValue(avgGain, avgLoss);
  }
  return result;
}

function rsiValue(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) {
    return avgGain === 0 ? 50 : 100;
  }
  const relativeStrength = avgGain / avgLoss;
  return 100 - 100 / (1 + relativeStrength);
}

export function macd(
  candles: CandleInput[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MACDValues {
  const closes = candles.map((c) => c.close);
  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);

  const macdLine: (number | null)[] = closes.map(() => null);
  const macdPoints: { index: number; value: number }[] = [];
  for (let i = 0; i < closes.length; i++) {
    const fastValue = fast[i];
    const slowValue = slow[i];
    if (fastValue !== null && slowValue !== null) {
      const value = fastValue - slowValue;
      macdLine[i] = value;
      macdPoints.push({ index: i, value });
    }
  }

  const signalLine: (number | null)[] = closes.map(() => null);
  const histogram: (number | null)[] = closes.map(() => null);
  if (signalPeriod <= 0 || macdPoints.length < signalPeriod) {
    return { macdLine, signalLine, histogram };
  }

  // Signal EMA runs over the compacted non-null MACD points (iOS behavior).
  let seed = 0;
  for (let i = 0; i < signalPeriod; i++) seed += macdPoints[i].value;
  seed /= signalPeriod;
  const seedIndex = macdPoints[signalPeriod - 1].index;
  signalLine[seedIndex] = seed;
  const macdAtSeed = macdLine[seedIndex];
  if (macdAtSeed !== null) histogram[seedIndex] = macdAtSeed - seed;

  const multiplier = 2 / (signalPeriod + 1);
  let previous = seed;
  for (let p = signalPeriod; p < macdPoints.length; p++) {
    const point = macdPoints[p];
    const signal = point.value * multiplier + previous * (1 - multiplier);
    signalLine[point.index] = signal;
    histogram[point.index] = point.value - signal;
    previous = signal;
  }
  return { macdLine, signalLine, histogram };
}

/** SMA over a nullable series: smooths the contiguous non-null tail. */
function smaNullable(values: (number | null)[], period: number): (number | null)[] {
  const result: (number | null)[] = values.map(() => null);
  const points: { index: number; value: number }[] = [];
  values.forEach((value, index) => {
    if (value !== null) points.push({ index, value });
  });
  if (period <= 0 || points.length < period) return result;
  let windowSum = 0;
  for (let i = 0; i < points.length; i++) {
    windowSum += points[i].value;
    if (i >= period) windowSum -= points[i - period].value;
    if (i >= period - 1) result[points[i].index] = windowSum / period;
  }
  return result;
}

export interface StochasticValues {
  k: (number | null)[];
  d: (number | null)[];
}

export function stochastic(
  candles: CandleInput[],
  kPeriod = 14,
  kSmooth = 3,
  dPeriod = 3,
): StochasticValues {
  const raw: (number | null)[] = candles.map(() => null);
  if (kPeriod > 0 && candles.length >= kPeriod) {
    // Monotonic deques of indices give the trailing window's high/low in
    // amortized O(1) per bar instead of rescanning the last `kPeriod` bars.
    const highDeque: number[] = [];
    const lowDeque: number[] = [];
    for (let i = 0; i < candles.length; i++) {
      while (
        highDeque.length > 0 &&
        candles[highDeque[highDeque.length - 1]].high <= candles[i].high
      ) {
        highDeque.pop();
      }
      highDeque.push(i);
      while (lowDeque.length > 0 && candles[lowDeque[lowDeque.length - 1]].low >= candles[i].low) {
        lowDeque.pop();
      }
      lowDeque.push(i);

      const windowStart = i - kPeriod + 1;
      if (highDeque[0] < windowStart) highDeque.shift();
      if (lowDeque[0] < windowStart) lowDeque.shift();

      if (i >= kPeriod - 1) {
        const highest = candles[highDeque[0]].high;
        const lowest = candles[lowDeque[0]].low;
        const range = highest - lowest;
        raw[i] = range === 0 ? 50 : ((candles[i].close - lowest) / range) * 100;
      }
    }
  }
  const k = smaNullable(raw, kSmooth);
  const d = smaNullable(k, dPeriod);
  return { k, d };
}

// Wilder's smoothing, seeded with the average true range of the first period.
export function atr(candles: CandleInput[], period = 14): (number | null)[] {
  const result: (number | null)[] = candles.map(() => null);
  if (period <= 0 || candles.length <= period) return result;
  const trueRanges: number[] = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const prevClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - prevClose),
      Math.abs(candle.low - prevClose),
    );
  });
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trueRanges[i];
  let value = sum / period;
  result[period] = value;
  for (let i = period + 1; i < candles.length; i++) {
    value = (value * (period - 1) + trueRanges[i]) / period;
    result[i] = value;
  }
  return result;
}

// Population (÷N) standard deviation, like the iOS implementation.
export function bollingerBands(
  candles: CandleInput[],
  period = 20,
  multiplier = 2,
): BollingerBandsValues {
  const closes = candles.map((c) => c.close);
  const upper: (number | null)[] = closes.map(() => null);
  const middle: (number | null)[] = closes.map(() => null);
  const lower: (number | null)[] = closes.map(() => null);
  if (period <= 0 || closes.length < period) {
    return { upper, middle, lower };
  }
  // Rolling sum/sum-of-squares: var = E[x^2] - E[x]^2, updated in O(1) per bar
  // instead of re-slicing and re-scanning the trailing window every index.
  let sum = 0;
  let sumSquares = 0;
  for (let i = 0; i < period; i++) {
    sum += closes[i];
    sumSquares += closes[i] * closes[i];
  }
  for (let i = period - 1; i < closes.length; i++) {
    if (i >= period) {
      const dropped = closes[i - period];
      sum += closes[i] - dropped;
      sumSquares += closes[i] * closes[i] - dropped * dropped;
    }
    const mean = sum / period;
    const variance = Math.max(0, sumSquares / period - mean * mean);
    const standardDeviation = Math.sqrt(variance);
    middle[i] = mean;
    upper[i] = mean + multiplier * standardDeviation;
    lower[i] = mean - multiplier * standardDeviation;
  }
  return { upper, middle, lower };
}

/** Last non-null value of a series (pane-card readouts). */
export function lastValue(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const value = values[i];
    if (value !== null) return value;
  }
  return null;
}

interface IndicatorExecutionContext {
  candles: TimedCandleInput[];
  closes: number[];
  parameter: (id: string) => number;
}

type IndicatorExecutor = (context: IndicatorExecutionContext) => IndicatorGeometry;

export type L2IndicatorId =
  | 'spread'
  | 'top_book_imbalance'
  | 'tick_pressure'
  | 'depth_imbalance'
  | 'cumulative_pressure'
  | 'touch_depletion';

interface L2IndicatorExecutionContext {
  indicators: OrderBookIndicators;
  candleCount: number;
}

type L2IndicatorExecutor = (context: L2IndicatorExecutionContext) => IndicatorGeometry;

function latestPublishedValue(candleCount: number, value: number | null): Array<number | null> {
  const values = Array<number | null>(candleCount).fill(null);
  if (candleCount > 0) values[candleCount - 1] = value;
  return values;
}

/**
 * Exhaustive live-L2 catalog. The server owns the windowed microstructure
 * formulas; desktop only maps each latest published result to the current
 * candle and never invents historical zeroes.
 */
export const L2_INDICATOR_EXECUTORS = {
  spread: ({ indicators, candleCount }) => ({
    kind: 'multi_line',
    series: {
      absolute: latestPublishedValue(candleCount, indicators.spreadAbs),
      bps: latestPublishedValue(candleCount, indicators.spreadBps),
      percentile: latestPublishedValue(candleCount, indicators.spreadPercentile),
    },
  }),
  top_book_imbalance: ({ indicators, candleCount }) => ({
    kind: 'histogram',
    series: { value: latestPublishedValue(candleCount, indicators.topBookImbalance) },
  }),
  tick_pressure: ({ indicators, candleCount }) => ({
    kind: 'histogram',
    series: { value: latestPublishedValue(candleCount, indicators.tickPressure) },
  }),
  depth_imbalance: ({ indicators, candleCount }) => ({
    kind: 'histogram',
    series: { value: latestPublishedValue(candleCount, indicators.depthImbalance) },
  }),
  cumulative_pressure: ({ indicators, candleCount }) => ({
    kind: 'histogram',
    series: { value: latestPublishedValue(candleCount, indicators.cumulativePressure) },
  }),
  touch_depletion: ({ indicators, candleCount }) => ({
    kind: 'histogram',
    series: { value: latestPublishedValue(candleCount, indicators.touchDepletion) },
  }),
} satisfies Record<L2IndicatorId, L2IndicatorExecutor>;

function isL2IndicatorId(id: IndicatorId): id is L2IndicatorId {
  return Object.hasOwn(L2_INDICATOR_EXECUTORS, id);
}

const l2Unavailable: IndicatorExecutor = () => {
  throw new Error('No L2 data');
};

/**
 * Exhaustive canonical dispatch table. The shared IndicatorId union makes a
 * missing or stale entry a compile error, while the runtime registry test
 * protects against a generated-contract/runtime-registry mismatch.
 */
export const INDICATOR_EXECUTORS = {
  sma: ({ closes, parameter }) => ({
    kind: 'line',
    series: { value: sma(closes, parameter('period')) },
  }),
  ema: ({ closes, parameter }) => ({
    kind: 'line',
    series: { value: ema(closes, parameter('period')) },
  }),
  rsi: ({ candles, parameter }) => ({
    kind: 'line',
    series: { value: rsi(candles, parameter('period')) },
  }),
  macd: ({ candles, parameter }) => {
    const result = macd(
      candles,
      parameter('fastPeriod'),
      parameter('slowPeriod'),
      parameter('signalPeriod'),
    );
    return {
      kind: 'multi_line',
      series: {
        macd: result.macdLine,
        signal: result.signalLine,
        histogram: result.histogram,
      },
    };
  },
  bollinger: ({ candles, parameter }) => {
    const result = bollingerBands(candles, parameter('period'), parameter('multiplier'));
    return {
      kind: 'band',
      series: { upper: result.upper, middle: result.middle, lower: result.lower },
    };
  },
  stochastic: ({ candles, parameter }) => {
    const result = stochastic(
      candles,
      parameter('kPeriod'),
      parameter('kSmooth'),
      parameter('dPeriod'),
    );
    return { kind: 'multi_line', series: { k: result.k, d: result.d } };
  },
  atr: ({ candles, parameter }) => ({
    kind: 'line',
    series: { value: wilderAtr(candles, parameter('period')) },
  }),
  anchored_vwap: ({ candles, parameter }) => ({
    kind: 'line',
    series: { value: anchoredVwap(candles, parameter('anchorTimestamp')) },
  }),
  supertrend: ({ candles, parameter }) => {
    const result = supertrend(candles, parameter('atrPeriod'), parameter('multiplier'));
    return {
      kind: 'segmented_line',
      series: { bullish: result.bullish, bearish: result.bearish },
    };
  },
  keltner: ({ candles, parameter }) => {
    const result = keltner(
      candles,
      parameter('emaPeriod'),
      parameter('atrPeriod'),
      parameter('multiplier'),
    );
    return {
      kind: 'band',
      series: { upper: result.upper, middle: result.middle, lower: result.lower },
    };
  },
  vpvr: ({ candles, parameter }) => ({
    kind: 'price_profile',
    rows: volumeProfile(candles, parameter('rowCount'), parameter('valueAreaPercent')),
  }),
  adx_dmi: ({ candles, parameter }) => {
    const result = adxDmi(candles, parameter('period'));
    return {
      kind: 'multi_line',
      series: { adx: result.adx, plusDi: result.plusDi, minusDi: result.minusDi },
    };
  },
  obv: ({ candles }) => ({
    kind: 'line',
    series: { value: onBalanceVolume(candles) },
  }),
  cci: ({ candles, parameter }) => ({
    kind: 'line',
    series: { value: cci(candles, parameter('period')) },
  }),
  williams_r: ({ candles, parameter }) => ({
    kind: 'line',
    series: { value: williamsR(candles, parameter('period')) },
  }),
  ichimoku: ({ candles, parameter }) => ({
    kind: 'cloud',
    series: ichimoku(
      candles,
      parameter('conversionPeriod'),
      parameter('basePeriod'),
      parameter('spanBPeriod'),
      parameter('displacement'),
    ),
  }),
  spread: l2Unavailable,
  top_book_imbalance: l2Unavailable,
  tick_pressure: l2Unavailable,
  depth_imbalance: l2Unavailable,
  cumulative_pressure: l2Unavailable,
  touch_depletion: l2Unavailable,
} satisfies Record<IndicatorId, IndicatorExecutor>;

export function computeIndicatorGeometry(
  descriptor: IndicatorDescriptor,
  candles: TimedCandleInput[],
  parameters: Record<string, number>,
): IndicatorGeometry {
  if (descriptor.requiresL2) throw new Error('No L2 data');
  validateCandles(candles);
  validateParameters(descriptor, parameters);
  const closes = candles.map(({ close }) => close);
  const parameter = (id: string): number => parameters[id];
  const geometry = INDICATOR_EXECUTORS[descriptor.id]({ candles, closes, parameter });
  validateGeometry(descriptor, geometry, candles.length);
  return geometry;
}

export function computeL2IndicatorGeometry(
  descriptor: IndicatorDescriptor,
  indicators: OrderBookIndicators,
  candleCount: number,
): IndicatorGeometry {
  if (!descriptor.requiresL2) throw new Error(`${descriptor.id} does not use L2 data.`);
  if (!Number.isInteger(candleCount) || candleCount < 0) {
    throw new Error('L2 candle count is invalid.');
  }
  if (!isL2IndicatorId(descriptor.id)) {
    throw new Error(`Unsupported L2 indicator ${descriptor.id}`);
  }
  const executor = L2_INDICATOR_EXECUTORS[descriptor.id];
  const geometry = executor({ indicators, candleCount });
  validateGeometry(descriptor, geometry, candleCount);
  return geometry;
}

function validateCandles(candles: TimedCandleInput[]): void {
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  candles.forEach((candle, index) => {
    const values = [
      candle.timestamp,
      candle.open,
      candle.high,
      candle.low,
      candle.close,
      candle.volume,
    ];
    if (values.some((value) => !Number.isFinite(value))) {
      throw new Error(`Candle ${index} contains a nonfinite value.`);
    }
    if (candle.timestamp <= previousTimestamp) {
      throw new Error('Candle timestamps must be strictly increasing.');
    }
    if (
      candle.high < Math.max(candle.open, candle.close, candle.low) ||
      candle.low > Math.min(candle.open, candle.close, candle.high) ||
      candle.volume < 0
    ) {
      throw new Error(`Candle ${index} has invalid OHLCV bounds.`);
    }
    previousTimestamp = candle.timestamp;
  });
}

function validateParameters(
  descriptor: IndicatorDescriptor,
  parameters: Record<string, number>,
): void {
  const ids = Object.keys(descriptor.parameters);
  if (
    Object.keys(parameters).length !== ids.length ||
    Object.keys(parameters).some((id) => !descriptor.parameters[id])
  ) {
    throw new Error(`${descriptor.id} parameters contain an unknown or missing id.`);
  }
  for (const definition of Object.values(descriptor.parameters)) {
    const value = parameters[definition.id];
    if (
      !Number.isFinite(value) ||
      value < definition.minimum ||
      value > definition.maximum ||
      ((definition.kind === 'integer' || definition.kind === 'timestamp') &&
        !Number.isInteger(value))
    ) {
      throw new Error(`${descriptor.id}.${definition.id} is invalid.`);
    }
  }
  for (const constraint of descriptor.constraints ?? []) {
    if (parameters[constraint.left] >= parameters[constraint.right])
      throw new Error(constraint.message);
  }
}

function validateGeometry(
  descriptor: IndicatorDescriptor,
  geometry: IndicatorGeometry,
  candleCount: number,
): void {
  if (geometry.kind !== descriptor.geometry.kind) {
    throw new Error(`${descriptor.id} returned the wrong geometry kind.`);
  }
  if (geometry.kind === 'price_profile') {
    for (const row of geometry.rows) {
      if (
        !Number.isFinite(row.low) ||
        !Number.isFinite(row.high) ||
        !Number.isFinite(row.volume) ||
        row.low > row.high ||
        row.volume < 0
      ) {
        throw new Error(`${descriptor.id} returned invalid profile geometry.`);
      }
    }
    return;
  }
  const expectedIds = descriptor.geometry.series.map(({ id }) => id);
  if (
    Object.keys(geometry.series).length !== expectedIds.length ||
    Object.keys(geometry.series).some((id) => !expectedIds.includes(id))
  ) {
    throw new Error(`${descriptor.id} returned invalid geometry series.`);
  }
  for (const values of Object.values(geometry.series)) {
    if (
      values.length !== candleCount ||
      values.some((value) => value !== null && !Number.isFinite(value))
    ) {
      throw new Error(`${descriptor.id} returned nonfinite or unaligned geometry.`);
    }
  }
}

function trueRanges(candles: CandleInput[]): number[] {
  return candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
}

function wilderAtr(candles: CandleInput[], period: number): (number | null)[] {
  const result: (number | null)[] = candles.map(() => null);
  if (candles.length < period) return result;
  const ranges = trueRanges(candles);
  let value = ranges.slice(0, period).reduce((sum, range) => sum + range, 0) / period;
  result[period - 1] = value;
  for (let index = period; index < candles.length; index += 1) {
    value = (value * (period - 1) + ranges[index]) / period;
    result[index] = value;
  }
  return result;
}

const NEW_YORK_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function anchoredVwap(candles: TimedCandleInput[], anchorTimestamp: number): (number | null)[] {
  const result: (number | null)[] = candles.map(() => null);
  if (candles.length === 0) return result;
  const currentSession = NEW_YORK_DATE.format(new Date(candles[candles.length - 1].timestamp));
  const anchorIndex = candles.findIndex((candle) =>
    anchorTimestamp === 0
      ? NEW_YORK_DATE.format(new Date(candle.timestamp)) === currentSession
      : candle.timestamp >= anchorTimestamp,
  );
  if (anchorIndex < 0) return result;
  let priceVolume = 0;
  let volume = 0;
  for (let index = anchorIndex; index < candles.length; index += 1) {
    const candle = candles[index];
    priceVolume += ((candle.high + candle.low + candle.close) / 3) * candle.volume;
    volume += candle.volume;
    if (volume > 0) result[index] = priceVolume / volume;
  }
  return result;
}

function supertrend(candles: CandleInput[], period: number, multiplier: number) {
  const bullish: (number | null)[] = candles.map(() => null);
  const bearish: (number | null)[] = candles.map(() => null);
  const ranges = wilderAtr(candles, period);
  let finalUpper: number | null = null;
  let finalLower: number | null = null;
  let isBullish = false;
  for (let index = 0; index < candles.length; index += 1) {
    const range = ranges[index];
    if (range === null) continue;
    const candle = candles[index];
    const middle = (candle.high + candle.low) / 2;
    const basicUpper = middle + multiplier * range;
    const basicLower = middle - multiplier * range;
    if (finalUpper === null || finalLower === null) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      isBullish = candle.close >= middle;
    } else {
      const priorUpper: number = finalUpper;
      const priorLower: number = finalLower;
      const priorClose = candles[index - 1].close;
      finalUpper = basicUpper < priorUpper || priorClose > priorUpper ? basicUpper : priorUpper;
      finalLower = basicLower > priorLower || priorClose < priorLower ? basicLower : priorLower;
      if (!isBullish && candle.close > priorUpper) isBullish = true;
      else if (isBullish && candle.close < priorLower) isBullish = false;
    }
    if (isBullish) bullish[index] = finalLower;
    else bearish[index] = finalUpper;
  }
  return { bullish, bearish };
}

function keltner(candles: CandleInput[], emaPeriod: number, atrPeriod: number, multiplier: number) {
  const middle = ema(
    candles.map(({ close }) => close),
    emaPeriod,
  );
  const ranges = wilderAtr(candles, atrPeriod);
  const upper = middle.map((value, index) =>
    value === null || ranges[index] === null ? null : value + multiplier * ranges[index]!,
  );
  const lower = middle.map((value, index) =>
    value === null || ranges[index] === null ? null : value - multiplier * ranges[index]!,
  );
  return { upper, middle, lower };
}

function volumeProfile(candles: CandleInput[], rowCount: number, valueAreaPercent: number) {
  if (candles.length === 0) return [];
  const minimum = Math.min(...candles.map(({ low }) => low));
  const maximum = Math.max(...candles.map(({ high }) => high));
  if (minimum === maximum) {
    return [
      {
        low: minimum,
        high: maximum,
        volume: candles.reduce((sum, candle) => sum + candle.volume, 0),
        inValueArea: true,
      },
    ];
  }
  const width = (maximum - minimum) / rowCount;
  const volumes = Array.from({ length: rowCount }, () => 0);
  for (const candle of candles) {
    const typical = (candle.high + candle.low + candle.close) / 3;
    const index = Math.min(rowCount - 1, Math.floor((typical - minimum) / width));
    volumes[index] += candle.volume;
  }
  const threshold = volumes.reduce((sum, volume) => sum + volume, 0) * (valueAreaPercent / 100);
  let selectedVolume = 0;
  const selected = new Set<number>();
  const ranked = volumes
    .map((volume, index) => ({ volume, index }))
    .sort((left, right) => right.volume - left.volume || left.index - right.index);
  for (const row of ranked) {
    if (selectedVolume >= threshold) break;
    selected.add(row.index);
    selectedVolume += row.volume;
  }
  return volumes.map((volume, index) => ({
    low: minimum + width * index,
    high: index === rowCount - 1 ? maximum : minimum + width * (index + 1),
    volume,
    inValueArea: selected.has(index),
  }));
}

function adxDmi(candles: CandleInput[], period: number) {
  const adx: (number | null)[] = candles.map(() => null);
  const plusDi: (number | null)[] = candles.map(() => null);
  const minusDi: (number | null)[] = candles.map(() => null);
  if (candles.length <= period) return { adx, plusDi, minusDi };
  const tr = trueRanges(candles);
  const plusDm = candles.map(() => 0);
  const minusDm = candles.map(() => 0);
  for (let index = 1; index < candles.length; index += 1) {
    const up = candles[index].high - candles[index - 1].high;
    const down = candles[index - 1].low - candles[index].low;
    if (up > 0 && up > down) plusDm[index] = up;
    if (down > 0 && down > up) minusDm[index] = down;
  }
  let trSum = 0;
  let plusSum = 0;
  let minusSum = 0;
  for (let index = 1; index <= period; index += 1) {
    trSum += tr[index];
    plusSum += plusDm[index];
    minusSum += minusDm[index];
  }
  const dx: (number | null)[] = candles.map(() => null);
  for (let index = period; index < candles.length; index += 1) {
    if (index > period) {
      trSum = trSum - trSum / period + tr[index];
      plusSum = plusSum - plusSum / period + plusDm[index];
      minusSum = minusSum - minusSum / period + minusDm[index];
    }
    const plus = trSum === 0 ? 0 : (100 * plusSum) / trSum;
    const minus = trSum === 0 ? 0 : (100 * minusSum) / trSum;
    plusDi[index] = plus;
    minusDi[index] = minus;
    dx[index] = plus + minus === 0 ? 0 : (100 * Math.abs(plus - minus)) / (plus + minus);
  }
  const seedIndex = 2 * period - 1;
  if (seedIndex < candles.length) {
    let current = 0;
    for (let index = period; index <= seedIndex; index += 1) current += dx[index]!;
    current /= period;
    adx[seedIndex] = current;
    for (let index = seedIndex + 1; index < candles.length; index += 1) {
      current = (current * (period - 1) + dx[index]!) / period;
      adx[index] = current;
    }
  }
  return { adx, plusDi, minusDi };
}

function onBalanceVolume(candles: CandleInput[]): (number | null)[] {
  if (candles.length === 0) return [];
  const result: (number | null)[] = candles.map(() => 0);
  for (let index = 1; index < candles.length; index += 1) {
    const direction = Math.sign(candles[index].close - candles[index - 1].close);
    result[index] = result[index - 1]! + direction * candles[index].volume;
  }
  return result;
}

function cci(candles: CandleInput[], period: number): (number | null)[] {
  const typical = candles.map((candle) => (candle.high + candle.low + candle.close) / 3);
  const result: (number | null)[] = candles.map(() => null);
  for (let index = period - 1; index < candles.length; index += 1) {
    const window = typical.slice(index - period + 1, index + 1);
    const mean = window.reduce((sum, value) => sum + value, 0) / period;
    const deviation = window.reduce((sum, value) => sum + Math.abs(value - mean), 0) / period;
    result[index] = deviation === 0 ? 0 : (typical[index] - mean) / (0.015 * deviation);
  }
  return result;
}

function williamsR(candles: CandleInput[], period: number): (number | null)[] {
  const result: (number | null)[] = candles.map(() => null);
  for (let index = period - 1; index < candles.length; index += 1) {
    const window = candles.slice(index - period + 1, index + 1);
    const high = Math.max(...window.map((candle) => candle.high));
    const low = Math.min(...window.map((candle) => candle.low));
    result[index] = high === low ? -50 : (-100 * (high - candles[index].close)) / (high - low);
  }
  return result;
}

function midpoint(candles: CandleInput[], period: number): (number | null)[] {
  const result: (number | null)[] = candles.map(() => null);
  for (let index = period - 1; index < candles.length; index += 1) {
    const window = candles.slice(index - period + 1, index + 1);
    result[index] =
      (Math.max(...window.map((candle) => candle.high)) +
        Math.min(...window.map((candle) => candle.low))) /
      2;
  }
  return result;
}

function ichimoku(
  candles: CandleInput[],
  conversionPeriod: number,
  basePeriod: number,
  spanBPeriod: number,
  displacement: number,
) {
  const conversion = midpoint(candles, conversionPeriod);
  const base = midpoint(candles, basePeriod);
  const spanBSource = midpoint(candles, spanBPeriod);
  const spanA: (number | null)[] = candles.map(() => null);
  const spanB: (number | null)[] = candles.map(() => null);
  const lagging: (number | null)[] = candles.map(() => null);
  for (let index = 0; index < candles.length; index += 1) {
    const forward = index + displacement;
    if (forward < candles.length && conversion[index] !== null && base[index] !== null) {
      spanA[forward] = (conversion[index]! + base[index]!) / 2;
    }
    if (forward < candles.length && spanBSource[index] !== null)
      spanB[forward] = spanBSource[index];
    const backward = index - displacement;
    if (backward >= 0) lagging[backward] = candles[index].close;
  }
  return { conversion, base, spanA, spanB, lagging };
}
