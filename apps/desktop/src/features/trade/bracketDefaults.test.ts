import { describe, expect, it } from 'vitest';
import { bracketKindFor } from '@0dtetrader/shared-types';
import { defaultBracketLevel } from './bracketDefaults';

describe('defaultBracketLevel', () => {
  it('long call: target 0.25% above entry, stop 0.25% below', () => {
    expect(defaultBracketLevel('target', 'call', 1, 600)).toBe(601.5);
    expect(defaultBracketLevel('stop', 'call', 1, 600)).toBe(598.5);
  });

  it('long put: profits when the underlying falls, so target sits below', () => {
    expect(defaultBracketLevel('target', 'put', 1, 600)).toBe(598.5);
    expect(defaultBracketLevel('stop', 'put', 1, 600)).toBe(601.5);
  });

  it('a short position inverts the directions', () => {
    expect(defaultBracketLevel('target', 'call', -1, 600)).toBe(598.5);
    expect(defaultBracketLevel('stop', 'put', -1, 600)).toBe(598.5);
  });

  it('rounds to cents', () => {
    expect(defaultBracketLevel('target', 'call', 1, 500.37)).toBe(501.62);
  });

  it('every level round-trips through the drag classifier as its own kind', () => {
    for (const optionType of ['call', 'put'] as const) {
      for (const quantity of [2, -2]) {
        for (const kind of ['stop', 'target'] as const) {
          const level = defaultBracketLevel(kind, optionType, quantity, 500);
          expect(bracketKindFor(optionType, quantity, 500, level)).toBe(kind);
        }
      }
    }
  });
});
