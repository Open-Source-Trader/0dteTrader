import { describe, expect, it } from 'vitest';
import {
  bracketKindFor,
  chartOrderCrossed,
  positionProfitDirection,
} from '@0dtetrader/shared-types';

/**
 * Which way is "up" for a bracket depends on the contract, not the screen.
 * Getting this backwards would put every put's target where the position loses
 * money — the single most expensive thing this feature could get wrong.
 */
describe('bracket direction', () => {
  it('profits upward on a long call and downward on a long put', () => {
    expect(positionProfitDirection('call', 1)).toBe(1);
    expect(positionProfitDirection('put', 1)).toBe(-1);
  });

  it('inverts again for short positions', () => {
    expect(positionProfitDirection('call', -1)).toBe(-1);
    expect(positionProfitDirection('put', -1)).toBe(1);
  });

  it('drags up to a target and down to a stop on a long call', () => {
    expect(bracketKindFor('call', 1, 100, 105)).toBe('target');
    expect(bracketKindFor('call', 1, 100, 95)).toBe('stop');
  });

  it('drags DOWN to a target on a long put, because that is where it wins', () => {
    expect(bracketKindFor('put', 1, 100, 95)).toBe('target');
    expect(bracketKindFor('put', 1, 100, 105)).toBe('stop');
  });

  it('inverts once more for a short call', () => {
    expect(bracketKindFor('call', -1, 100, 95)).toBe('target');
    expect(bracketKindFor('call', -1, 100, 105)).toBe('stop');
  });
});

describe('chartOrderCrossed', () => {
  const armedAbove = { armPrice: 100, triggerPrice: 98 };
  const armedBelow = { armPrice: 100, triggerPrice: 105 };

  it('fires a line armed above only on the way down through it', () => {
    expect(chartOrderCrossed(armedAbove, 100, 97)).toBe(true);
    expect(chartOrderCrossed(armedAbove, 100, 99)).toBe(false);
    expect(chartOrderCrossed(armedAbove, 97, 100)).toBe(false);
  });

  it('fires a line armed below only on the way up through it', () => {
    expect(chartOrderCrossed(armedBelow, 100, 106)).toBe(true);
    expect(chartOrderCrossed(armedBelow, 100, 104)).toBe(false);
    expect(chartOrderCrossed(armedBelow, 106, 100)).toBe(false);
  });

  it('counts touching the level exactly as a cross', () => {
    expect(chartOrderCrossed(armedAbove, 100, 98)).toBe(true);
    expect(chartOrderCrossed(armedBelow, 100, 105)).toBe(true);
  });

  it('rejects non-finite prices rather than guessing', () => {
    expect(chartOrderCrossed(armedAbove, Number.NaN, 90)).toBe(false);
    expect(chartOrderCrossed(armedAbove, 100, Number.POSITIVE_INFINITY)).toBe(false);
  });
});
