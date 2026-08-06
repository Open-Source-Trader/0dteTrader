import { describe, expect, it } from 'vitest';
import { sameColorsExceptLast } from './candleRepaint';
import { extendPriceRange } from './priceReveal';
import { normalizeVisibleCandleViewport } from './candleViewport';

describe('sameColorsExceptLast', () => {
  it('treats null vs array as different', () => {
    expect(sameColorsExceptLast(null, ['a'])).toBe(false);
    expect(sameColorsExceptLast(['a'], null)).toBe(false);
    expect(sameColorsExceptLast(null, null)).toBe(false);
  });

  it('detects a length change (new candle) as a difference', () => {
    // A new candle appended: arrays differ in length → caller must full-repaint.
    expect(sameColorsExceptLast(['a', 'b'], ['a', 'b', 'c'])).toBe(false);
    expect(sameColorsExceptLast(['a', 'b', 'c'], ['a', 'b'])).toBe(false);
  });

  it('ignores a change only in the last (forming) candle', () => {
    // Only the live bar's color changed → cheap update() path suffices.
    expect(sameColorsExceptLast(['a', 'b', 'c'], ['a', 'b', 'd'])).toBe(true);
    expect(sameColorsExceptLast(['a'], ['b'])).toBe(true);
  });

  it('flags a change in any prior candle', () => {
    expect(sameColorsExceptLast(['a', 'b', 'c'], ['x', 'b', 'c'])).toBe(false);
    expect(sameColorsExceptLast(['a', 'b', 'c'], ['a', 'x', 'c'])).toBe(false);
  });

  it('treats identical arrays as equal', () => {
    expect(sameColorsExceptLast(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(true);
  });
});

describe('extendPriceRange ("Show on chart" reveal)', () => {
  it('returns the range untouched when the price is already inside', () => {
    // Which is also what restores the viewport once the reveal clears: the
    // provider hands back the base autoscale range unmodified.
    expect(extendPriceRange(100, 110, 105)).toEqual({ min: 100, max: 110 });
    expect(extendPriceRange(100, 110, 100)).toEqual({ min: 100, max: 110 });
    expect(extendPriceRange(100, 110, 110)).toEqual({ min: 100, max: 110 });
  });

  it('extends downward with padding for a price below the range (a stop)', () => {
    const { min, max } = extendPriceRange(100, 110, 90);
    expect(max).toBe(110);
    // Inside the viewport, not pinned to its edge — but only by a few percent.
    expect(min).toBeLessThan(90);
    expect(min).toBeGreaterThanOrEqual(90 - (110 - 90) * 0.1);
  });

  it('extends upward with padding for a price above the range (a target)', () => {
    const { min, max } = extendPriceRange(100, 110, 120);
    expect(min).toBe(100);
    expect(max).toBeGreaterThan(120);
    expect(max).toBeLessThanOrEqual(120 + (120 - 100) * 0.1);
  });
});

describe('normalizeVisibleCandleViewport', () => {
  it('includes partially visible candles and clamps whitespace to loaded data', () => {
    expect(normalizeVisibleCandleViewport({ from: -4.2, to: 3.1 }, 10)).toEqual({
      kind: 'range',
      from: 0,
      to: 4,
    });
    expect(normalizeVisibleCandleViewport({ from: 7.8, to: 20 }, 10)).toEqual({
      kind: 'range',
      from: 7,
      to: 9,
    });
  });

  it('distinguishes an uninitialized scale from a valid empty intersection', () => {
    expect(normalizeVisibleCandleViewport(null, 10)).toEqual({ kind: 'uninitialized' });
    expect(normalizeVisibleCandleViewport({ from: 12, to: 20 }, 10)).toEqual({ kind: 'empty' });
    expect(normalizeVisibleCandleViewport({ from: -20, to: -2 }, 10)).toEqual({ kind: 'empty' });
    expect(normalizeVisibleCandleViewport({ from: 0, to: 2 }, 0)).toEqual({
      kind: 'uninitialized',
    });
  });
});
