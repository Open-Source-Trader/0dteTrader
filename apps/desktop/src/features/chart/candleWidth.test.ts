import { describe, expect, it } from 'vitest';
import { calculateVolumeWeightedWidth, percentile, referenceVolume } from './candleWidth';

const NORMAL_WIDTH = 10;
const MIN_RATIO = 0.2;
const MAX_RATIO = 0.95;

function width(volume: number, refVolume: number): number {
  return calculateVolumeWeightedWidth({
    volume,
    referenceVolume: refVolume,
    normalCandleWidth: NORMAL_WIDTH,
    minimumWidthRatio: MIN_RATIO,
    maximumWidthRatio: MAX_RATIO,
  });
}

describe('calculateVolumeWeightedWidth', () => {
  it('gives zero-volume candles the minimum width', () => {
    expect(width(0, 100)).toBeCloseTo(NORMAL_WIDTH * MIN_RATIO);
  });

  it('gives candles at or above the reference volume the maximum width', () => {
    expect(width(100, 100)).toBeCloseTo(NORMAL_WIDTH * MAX_RATIO);
    expect(width(500, 100)).toBeCloseTo(NORMAL_WIDTH * MAX_RATIO);
  });

  it('interpolates linearly between min and max for intermediate volumes', () => {
    const minWidth = NORMAL_WIDTH * MIN_RATIO;
    const maxWidth = NORMAL_WIDTH * MAX_RATIO;
    expect(width(50, 100)).toBeCloseTo(minWidth + (maxWidth - minWidth) * 0.5);
  });

  it('clamps extreme outliers to the maximum width instead of stretching the scale', () => {
    expect(width(1_000_000, 100)).toBeCloseTo(NORMAL_WIDTH * MAX_RATIO);
  });

  it('treats invalid volume (NaN, negative, non-finite) as zero', () => {
    const zeroWidth = width(0, 100);
    expect(width(NaN, 100)).toBeCloseTo(zeroWidth);
    expect(width(-50, 100)).toBeCloseTo(zeroWidth);
    expect(width(Infinity, 100)).not.toBeCloseTo(NORMAL_WIDTH * MAX_RATIO);
    expect(width(Infinity, 100)).toBeCloseTo(zeroWidth);
  });

  it('falls back to the normal candle width when the reference volume is zero or invalid', () => {
    expect(width(100, 0)).toBe(NORMAL_WIDTH);
    expect(width(100, -5)).toBe(NORMAL_WIDTH);
    expect(width(100, NaN)).toBe(NORMAL_WIDTH);
  });

  it('never returns a width below 1px even at extreme zoom-out', () => {
    expect(
      calculateVolumeWeightedWidth({
        volume: 0,
        referenceVolume: 100,
        normalCandleWidth: 1,
        minimumWidthRatio: MIN_RATIO,
        maximumWidthRatio: MAX_RATIO,
      }),
    ).toBe(1);
  });
});

describe('percentile', () => {
  it('returns 0 for an empty array', () => {
    expect(percentile([], 0.95)).toBe(0);
  });

  it('returns the single value for a one-element array', () => {
    expect(percentile([42], 0.95)).toBe(42);
  });

  it('does not mutate the input array', () => {
    const values = [5, 1, 3];
    percentile(values, 0.5);
    expect(values).toEqual([5, 1, 3]);
  });
});

describe('referenceVolume', () => {
  it('is 0 when the visible range is empty', () => {
    expect(referenceVolume([])).toBe(0);
  });

  it('is 0 when every visible candle has zero or invalid volume', () => {
    expect(referenceVolume([0, 0, 0])).toBe(0);
    expect(referenceVolume([NaN, -1, 0])).toBe(0);
  });

  it('computes the 95th percentile over only the visible volumes', () => {
    const visible = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    // p95 rank = 0.95 * 99 = 94.05 -> interpolate between sorted[94]=95 and sorted[95]=96
    expect(referenceVolume(visible)).toBeCloseTo(95.05);
  });

  it('handles a single visible candle', () => {
    expect(referenceVolume([42])).toBe(42);
  });
});
