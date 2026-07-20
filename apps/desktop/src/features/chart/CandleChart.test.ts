import { describe, expect, it } from 'vitest';
import { sameColorsExceptLast } from './candleRepaint';

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
