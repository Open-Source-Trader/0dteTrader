import { describe, expect, it } from 'vitest';
import { positionProfitDirection } from '@0dtetrader/shared-types';
import { defaultBracketLevel } from './bracketDefaults';

describe('defaultBracketLevel (anchored on the LIVE underlying price)', () => {
  it('long call: target 0.25% above the market, stop 0.25% below', () => {
    expect(defaultBracketLevel('target', 'call', 1, 620)).toBe(621.55);
    expect(defaultBracketLevel('stop', 'call', 1, 620)).toBe(618.45);
  });

  it('long put: profits when the underlying falls, so its target sits below the market', () => {
    expect(defaultBracketLevel('target', 'put', 1, 620)).toBe(618.45);
    expect(defaultBracketLevel('stop', 'put', 1, 620)).toBe(621.55);
  });

  it('a short position inverts the directions', () => {
    expect(defaultBracketLevel('target', 'call', -1, 620)).toBe(618.45);
    expect(defaultBracketLevel('stop', 'put', -1, 620)).toBe(618.45);
  });

  it('rounds to cents', () => {
    expect(defaultBracketLevel('target', 'call', 1, 500.37)).toBe(501.62);
  });

  /** The wrong-side hazard this module exists to prevent: a default the
   *  market already sits beyond arms inverted (a "target" below the live
   *  price fires on the way down, like a stop). Anchoring on the live price
   *  puts every target on the profit side of it and every stop on the loss
   *  side, no matter where the entry was. */
  it('always lands targets on the profit side of the live price and stops on the loss side', () => {
    const price = 500;
    for (const optionType of ['call', 'put'] as const) {
      for (const quantity of [2, -2]) {
        const direction = positionProfitDirection(optionType, quantity);
        const target = defaultBracketLevel('target', optionType, quantity, price);
        const stop = defaultBracketLevel('stop', optionType, quantity, price);
        expect(Math.sign(target - price)).toBe(direction);
        expect(Math.sign(stop - price)).toBe(-direction);
      }
    }
  });
});
