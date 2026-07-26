import { describe, expect, it } from 'vitest';
import { resolveGuidePrice } from './placementGuide';

const range = { min: 500, max: 520 };
// Deliberately not the midpoint (510). An in-range last price that collided with
// the midpoint fallback would let "re-anchored to the last price" and "fell all
// the way through" pass the same assertion, so deleting a branch would not fail
// the test that names it.
const lastPrice = 512;

describe('resolveGuidePrice', () => {
  it('leaves a guide that is already in view where the user put it', () => {
    expect(resolveGuidePrice(507.5, lastPrice, range)).toBe(507.5);
  });

  it('parks at the last traded price when there is no guide yet', () => {
    expect(resolveGuidePrice(null, lastPrice, range)).toBe(512);
  });

  it('re-anchors to the last price when the axis pans away from the guide', () => {
    expect(resolveGuidePrice(480, lastPrice, range)).toBe(512);
  });

  it('clamps into view when the last price is off-screen too', () => {
    expect(resolveGuidePrice(480, 470, range)).toBe(500);
    expect(resolveGuidePrice(560, 570, range)).toBe(520);
  });

  it('falls back to the middle of the range with nothing to seed from', () => {
    expect(resolveGuidePrice(null, null, range)).toBe(510);
  });

  it('leaves the guide alone when the range is degenerate', () => {
    expect(resolveGuidePrice(507.5, lastPrice, { min: 520, max: 500 })).toBe(507.5);
    expect(resolveGuidePrice(507.5, lastPrice, { min: NaN, max: 520 })).toBe(507.5);
    // An axis zoomed to a single price is the realistic degenerate case, and the
    // strict `max <= min` guard has to reject it too.
    expect(resolveGuidePrice(507.5, lastPrice, { min: 510, max: 510 })).toBe(507.5);
  });

  it('ignores a non-finite guide or last price', () => {
    expect(resolveGuidePrice(NaN, lastPrice, range)).toBe(512);
    expect(resolveGuidePrice(Infinity, lastPrice, range)).toBe(512);
    // Nothing usable to seed from once a NaN last price is discarded, so this
    // one lands on the midpoint rather than the last price.
    expect(resolveGuidePrice(null, NaN, range)).toBe(510);
  });

  it('counts the visible edges as in view', () => {
    expect(resolveGuidePrice(500, lastPrice, range)).toBe(500);
    expect(resolveGuidePrice(520, lastPrice, range)).toBe(520);
  });

  it('never hands back a non-finite level', () => {
    expect(resolveGuidePrice(NaN, lastPrice, { min: NaN, max: 520 })).toBeNull();
  });
});
