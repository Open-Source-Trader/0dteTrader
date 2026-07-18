/**
 * Pure indicator math over candles (IndicatorEngine.swift port, 1:1 including
 * the MACD signal-over-compacted-points behavior). Every function returns an
 * array aligned with the input; warm-up indices are `null`.
 */

export interface CandleInput {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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
  for (let i = period - 1; i < closes.length; i++) {
    const window = closes.slice(i - period + 1, i + 1);
    const mean = window.reduce((sum, v) => sum + v, 0) / period;
    const variance = window.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / period;
    const standardDeviation = Math.sqrt(variance);
    middle[i] = mean;
    upper[i] = mean + multiplier * standardDeviation;
    lower[i] = mean - multiplier * standardDeviation;
  }
  return { upper, middle, lower };
}
