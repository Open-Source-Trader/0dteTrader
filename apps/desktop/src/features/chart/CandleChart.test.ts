import { describe, expect, it } from 'vitest';
import { sameColorsExceptLast } from './candleRepaint';
import { extendPriceRange } from './priceReveal';

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
