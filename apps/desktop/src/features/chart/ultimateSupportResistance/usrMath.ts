import type { UsrAnalysisCandle, UsrCandle } from './usrTypes';

const NEW_YORK_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function quantizedPriceKey(price: number, minimumTick: number): string {
  const scaled = Math.round(price / minimumTick);
  if (Number.isSafeInteger(scaled)) return String(scaled);
  // Preserve a deterministic *quantized* identity even when tick scaling
  // exceeds the exact-integer range. Decimal formatting is locale/runtime
  // dependent; the rounded scaled value's IEEE-754 bits are cross-platform.
  const bytes = new DataView(new ArrayBuffer(8));
  const overflowed = !Number.isFinite(scaled);
  bytes.setFloat64(0, overflowed ? price : scaled, false);
  const prefix = overflowed ? 'price-bits' : 'bits';
  return `${prefix}:${bytes.getBigUint64(0, false).toString(16).padStart(16, '0')}`;
}

export function isFiniteCandle(candle: UsrCandle): boolean {
  return (
    Number.isFinite(candle.time) &&
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.close) &&
    Number.isFinite(candle.volume) &&
    candle.high >= candle.low &&
    candle.open >= candle.low &&
    candle.open <= candle.high &&
    candle.close >= candle.low &&
    candle.close <= candle.high &&
    candle.volume >= 0
  );
}

export function isRegularSession(epochSeconds: number): boolean {
  const parts = NEW_YORK_PARTS.formatToParts(new Date(epochSeconds * 1_000));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (value.weekday === 'Sat' || value.weekday === 'Sun') return false;
  const minute = Number(value.hour) * 60 + Number(value.minute);
  return minute >= 9 * 60 + 30 && minute < 16 * 60;
}

export function trueRange(current: UsrCandle, previous: UsrCandle | undefined): number {
  if (!previous) return current.high - current.low;
  return Math.max(
    current.high - current.low,
    Math.abs(current.high - previous.close),
    Math.abs(current.low - previous.close),
  );
}

/** Pine's ta.atr(): an SMA seed followed by Wilder's RMA. */
export function atrSeries(candles: readonly UsrCandle[], length = 14): Array<number | null> {
  const result: Array<number | null> = Array.from({ length: candles.length }, () => null);
  if (length <= 0) return result;
  const ranges = candles.map((candle, index) => trueRange(candle, candles[index - 1]));
  let seed = 0;
  for (let index = 0; index < ranges.length; index += 1) {
    seed += ranges[index];
    if (index === length - 1) result[index] = seed / length;
    else if (index >= length) {
      const previous = result[index - 1];
      result[index] = previous === null ? null : (previous * (length - 1) + ranges[index]) / length;
    }
  }
  return result;
}

function sampleDeviation(values: readonly number[], mean: number): number {
  if (values.length === 0) return 0;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Pine-compatible lagged volume baselines. Conditional session series skip na
 * values, so each session keeps an independent lookback without future data.
 */
export function applyLaggedVolumeBaselines(
  candles: UsrAnalysisCandle[],
  lookback: number,
  sessionAware: boolean,
  intraday: boolean,
): void {
  const all: number[] = [];
  const regular: number[] = [];
  const extended: number[] = [];
  for (const candle of candles) {
    let selected = all;
    if (sessionAware && intraday) selected = candle.regularSession ? regular : extended;
    const fallback = all.length >= lookback ? all.slice(-lookback) : null;
    const sample = selected.length >= lookback ? selected.slice(-lookback) : fallback;
    if (sample) {
      const mean = sample.reduce((sum, value) => sum + value, 0) / sample.length;
      candle.volumeMean = mean;
      candle.volumeStd = sampleDeviation(sample, mean);
    } else {
      candle.volumeMean = null;
      candle.volumeStd = null;
    }
    all.push(candle.volume);
    (candle.regularSession ? regular : extended).push(candle.volume);
  }
}

export function volumeRatio(volume: number, mean: number | null): number {
  return mean !== null && mean > 0 ? volume / mean : 0;
}

export function volumeZScore(
  volume: number,
  mean: number | null,
  standardDeviation: number | null,
): number {
  return mean !== null && standardDeviation !== null && standardDeviation > 0
    ? (volume - mean) / standardDeviation
    : 0;
}

export function isVolumeAnomaly(
  candle: Pick<UsrAnalysisCandle, 'volume' | 'volumeMean' | 'volumeStd'>,
  minimumRatio: number,
  minimumZScore: number,
): boolean {
  const ratio = volumeRatio(candle.volume, candle.volumeMean);
  const dispersionReady = candle.volumeStd !== null && candle.volumeStd > 0;
  return (
    ratio >= minimumRatio &&
    (!dispersionReady ||
      volumeZScore(candle.volume, candle.volumeMean, candle.volumeStd) >= minimumZScore)
  );
}

export function isDirectionalDisplacement(
  candle: Pick<UsrAnalysisCandle, 'open' | 'high' | 'low' | 'close' | 'atr'>,
  bullish: boolean,
  bodyPercent: number,
  atrMultiplier: number,
  minimumTick: number,
): boolean {
  const range = Math.max(candle.high - candle.low, minimumTick);
  const body = Math.abs(candle.close - candle.open);
  const directionMatches = bullish ? candle.close > candle.open : candle.close < candle.open;
  return (
    directionMatches &&
    (body / range) * 100 >= bodyPercent &&
    candle.atr !== null &&
    candle.atr > 0 &&
    body >= candle.atr * atrMultiplier
  );
}
