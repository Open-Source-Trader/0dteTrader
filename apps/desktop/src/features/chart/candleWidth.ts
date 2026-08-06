/** 95th-percentile reference volume and volume-weighted candle body width,
 *  isolated from lightweight-charts and UI state so it can be unit-tested and
 *  reused by the paint layer without touching series/coordinate APIs. */

/** Linear-interpolation percentile over a copy of `values` (unsorted input is
 *  fine; the source array is never mutated). Only ever called with the
 *  currently visible slice, never the full historical dataset. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = p * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  if (lowerIndex === upperIndex) return sorted[lowerIndex];
  const weight = rank - lowerIndex;
  return sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * weight;
}

/** 95th percentile of the visible candles' volumes; 0 when there is nothing
 *  to normalize against (empty range, or every volume invalid/zero). */
export function referenceVolume(visibleVolumes: number[]): number {
  const valid = visibleVolumes.filter((v) => Number.isFinite(v) && v > 0);
  if (valid.length === 0) return 0;
  return percentile(valid, 0.95);
}

export interface CalculateVolumeWeightedWidthInput {
  volume: number;
  referenceVolume: number;
  normalCandleWidth: number;
  minimumWidthRatio: number;
  maximumWidthRatio: number;
}

/** Body width for one candle, proportional to its volume relative to the
 *  visible-range 95th percentile. Falls back to `normalCandleWidth` whenever
 *  there is no usable reference (empty/zero/invalid), which is also what
 *  keeps a single extreme spike from collapsing every other candle: that
 *  candle clamps to `maximumWidthRatio` instead of stretching the scale. */
export function calculateVolumeWeightedWidth({
  volume,
  referenceVolume,
  normalCandleWidth,
  minimumWidthRatio,
  maximumWidthRatio,
}: CalculateVolumeWeightedWidthInput): number {
  if (!Number.isFinite(referenceVolume) || referenceVolume <= 0) return normalCandleWidth;
  const safeVolume = Number.isFinite(volume) && volume > 0 ? volume : 0;
  const normalized = Math.min(1, Math.max(0, safeVolume / referenceVolume));
  const minWidth = Math.max(1, normalCandleWidth * minimumWidthRatio);
  const maxWidth = normalCandleWidth * maximumWidthRatio;
  return minWidth + (maxWidth - minWidth) * normalized;
}
