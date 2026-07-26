import { describe, expect, it } from 'vitest';
import { resolveGuidePrice } from './placementGuide';

const range = { min: 500, max: 520 };

describe('resolveGuidePrice', () => {
  it('leaves a guide that is in view exactly where the user summoned it', () => {
    expect(resolveGuidePrice(507.5, range)).toBe(507.5);
  });

  it('has no guide until one has been summoned', () => {
    expect(resolveGuidePrice(null, range)).toBeNull();
  });

  it('dismisses the guide when the axis pans the level out of view', () => {
    // Not re-anchored to anything: the level is one the user pointed at, and
    // quietly moving it elsewhere would arm an order they never chose.
    expect(resolveGuidePrice(480, range)).toBeNull();
    expect(resolveGuidePrice(560, range)).toBeNull();
  });

  it('counts the visible edges as in view', () => {
    expect(resolveGuidePrice(500, range)).toBe(500);
    expect(resolveGuidePrice(520, range)).toBe(520);
  });

  it('holds the level when the range is degenerate', () => {
    // No usable price transform this frame is a fact about the chart, not about
    // where the user put the guide, so it must not dismiss one.
    expect(resolveGuidePrice(507.5, { min: 520, max: 500 })).toBe(507.5);
    expect(resolveGuidePrice(507.5, { min: NaN, max: 520 })).toBe(507.5);
    // An axis zoomed to a single price is the realistic degenerate case, and the
    // strict `max <= min` guard has to reject it too.
    expect(resolveGuidePrice(507.5, { min: 510, max: 510 })).toBe(507.5);
  });

  it('never hands back a non-finite level', () => {
    expect(resolveGuidePrice(NaN, range)).toBeNull();
    expect(resolveGuidePrice(Infinity, range)).toBeNull();
    expect(resolveGuidePrice(NaN, { min: NaN, max: 520 })).toBeNull();
  });
});
