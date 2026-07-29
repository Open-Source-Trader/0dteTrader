import { describe, expect, it } from 'vitest';
import { bollingerBands, sma, stochastic, type CandleInput } from './indicatorEngine';

function candles(highs: number[], lows: number[], closes: number[]): CandleInput[] {
  return closes.map((close, i) => ({
    open: close,
    high: highs[i],
    low: lows[i],
    close,
    volume: 100,
  }));
}

function closeCandles(closes: number[]): CandleInput[] {
  return candles(closes, closes, closes);
}

describe('bollingerBands', () => {
  it('matches known values', () => {
    const result = bollingerBands(closeCandles([1, 2, 3, 4, 5]), 3, 2);
    const sd = Math.sqrt(2 / 3);
    expect(result.middle).toEqual([null, null, 2, 3, 4]);
    expect(result.upper[2]).toBeCloseTo(2 + 2 * sd, 9);
    expect(result.upper[3]).toBeCloseTo(3 + 2 * sd, 9);
    expect(result.upper[4]).toBeCloseTo(4 + 2 * sd, 9);
    expect(result.lower[2]).toBeCloseTo(2 - 2 * sd, 9);
    expect(result.lower[3]).toBeCloseTo(3 - 2 * sd, 9);
    expect(result.lower[4]).toBeCloseTo(4 - 2 * sd, 9);
  });

  it('middle equals SMA', () => {
    const input = closeCandles([3, 1, 4, 1, 5, 9, 2, 6]);
    const bands = bollingerBands(input, 4, 2);
    expect(bands.middle).toEqual(
      sma(
        input.map((c) => c.close),
        4,
      ),
    );
  });

  it('returns all null when shorter than the period', () => {
    const result = bollingerBands(closeCandles([1, 2]), 3, 2);
    expect(result.middle).toEqual([null, null]);
    expect(result.upper).toEqual([null, null]);
    expect(result.lower).toEqual([null, null]);
  });
});

describe('stochastic', () => {
  it('matches known %K/%D values', () => {
    const highs = [5, 6, 7, 8, 9, 10, 11];
    const lows = [1, 2, 3, 4, 5, 6, 7];
    const closes = [3, 4, 5, 6, 7, 8, 9];
    const result = stochastic(candles(highs, lows, closes), 3, 1, 1);
    // range = highest-lowest over trailing 3 bars = 6 each time; %K unsmoothed.
    // idx2: window[0..2] high=7 low=1 close=5 -> (5-1)/6*100
    expect(result.k[2]).toBeCloseTo(((5 - 1) / 6) * 100, 9);
    expect(result.d[2]).toBeCloseTo(((5 - 1) / 6) * 100, 9);
    expect(result.k[0]).toBeNull();
    expect(result.k[1]).toBeNull();
  });

  it('returns 50 when the trailing window has zero range', () => {
    const result = stochastic(candles([5, 5, 5], [5, 5, 5], [5, 5, 5]), 3, 1, 1);
    expect(result.k[2]).toBe(50);
  });

  it('returns all null when shorter than kPeriod', () => {
    const result = stochastic(candles([5, 6], [1, 2], [3, 4]), 3, 1, 1);
    expect(result.k).toEqual([null, null]);
    expect(result.d).toEqual([null, null]);
  });
});
