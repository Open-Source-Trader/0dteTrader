import { describe, expect, it } from 'vitest';
import { resolveGuidePrice } from './placementGuide';

const range = { min: 500, max: 520 };

describe('resolveGuidePrice', () => {
  it('leaves a guide that is already in view where the user put it', () => {
    expect(resolveGuidePrice(507.5, 510, range)).toBe(507.5);
  });

  it('parks at the last traded price when there is no guide yet', () => {
    expect(resolveGuidePrice(null, 510, range)).toBe(510);
  });

  it('re-anchors to the last price when the axis pans away from the guide', () => {
    expect(resolveGuidePrice(480, 510, range)).toBe(510);
  });

  it('clamps into view when the last price is off-screen too', () => {
    expect(resolveGuidePrice(480, 470, range)).toBe(500);
    expect(resolveGuidePrice(560, 570, range)).toBe(520);
  });

  it('falls back to the middle of the range with nothing to seed from', () => {
    expect(resolveGuidePrice(null, null, range)).toBe(510);
  });

  it('leaves the guide alone when the range is degenerate', () => {
    expect(resolveGuidePrice(507.5, 510, { min: 520, max: 500 })).toBe(507.5);
    expect(resolveGuidePrice(507.5, 510, { min: NaN, max: 520 })).toBe(507.5);
  });

  it('ignores a non-finite guide or last price', () => {
    expect(resolveGuidePrice(NaN, 510, range)).toBe(510);
  });
});
