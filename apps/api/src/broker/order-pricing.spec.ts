import {
  CUSTOM_PRICE_WARNING_MARGIN,
  MAX_LIMIT_PRICE,
  customPriceWarning,
  resolveLimitPrice,
  validateLimitPrice,
} from './order-pricing';

/** A normal, penny-wide 0DTE quote. */
const quote = { bid: 2.45, ask: 2.47, last: 2.46 };

describe('resolveLimitPrice', () => {
  it('prices each limit variant off the server quote, not the client', () => {
    expect(resolveLimitPrice('bid', quote)).toBe(2.45);
    expect(resolveLimitPrice('mid', quote)).toBe(2.46);
    expect(resolveLimitPrice('ask', quote)).toBe(2.47);
  });

  it('ignores a limitPrice the client attached to a server-priced variant', () => {
    // The DTO rejects this combination outright; the resolver must not honour
    // it either, or a bypassed validation would become a silent price override.
    expect(resolveLimitPrice('mid', quote, 99)).toBe(2.46);
    expect(resolveLimitPrice('bid', quote, 99)).toBe(2.45);
  });

  it('returns undefined for a market order — there is no limit to work', () => {
    expect(resolveLimitPrice('market', quote)).toBeUndefined();
    expect(resolveLimitPrice('market', quote, 2.5)).toBeUndefined();
  });

  it('works a custom order at the price the user typed', () => {
    expect(resolveLimitPrice('custom', quote, 2.4)).toBe(2.4);
    // Far outside the spread is a warning, not a refusal.
    expect(resolveLimitPrice('custom', quote, 24.5)).toBe(24.5);
  });

  it('falls back to the mid for a custom order with no price', () => {
    expect(resolveLimitPrice('custom', quote)).toBe(2.46);
  });

  it('never returns a non-finite or above-cap price for any mode', () => {
    // A malformed-but-FINITE broker quote (1e308 sides) used to flow through
    // the operand checks and out of the mid as Infinity — a non-finite
    // broker limit. The ceiling inside computeMid now refuses the book for
    // every server-priced mode, and the custom fallback rides the same gate.
    const absurd = { bid: 1e308, ask: 1e308, last: 1e308 };
    for (const mode of ['bid', 'mid', 'ask'] as const) {
      expect(() => resolveLimitPrice(mode, absurd)).toThrow(/crossed|invalid/);
    }
    expect(() => resolveLimitPrice('custom', absurd)).toThrow(/crossed|invalid/);

    // The invariant on the accepting side: every quote the resolver accepts
    // yields a finite, in-range price for each non-market mode.
    const accepted = [quote, { bid: 99_999.98, ask: 100_000, last: 99_999.99 }];
    for (const q of accepted) {
      for (const mode of ['bid', 'mid', 'ask'] as const) {
        const price = resolveLimitPrice(mode, q) as number;
        expect(Number.isFinite(price)).toBe(true);
        expect(price).toBeLessThanOrEqual(100_000);
      }
    }
  });

  it('refuses to price any limit variant against a crossed book', () => {
    const crossed = { bid: 2.5, ask: 2.4, last: 2.45 };
    for (const type of ['bid', 'mid', 'ask'] as const) {
      expect(() => resolveLimitPrice(type, crossed)).toThrow(/crossed or invalid/);
    }
  });

  it('rounds a raw quote to the cent', () => {
    expect(resolveLimitPrice('bid', { bid: 2.4499999, ask: 2.47, last: 2.46 })).toBe(2.45);
  });
});

describe('validateLimitPrice', () => {
  it('accepts a tick-aligned custom price', () => {
    expect(validateLimitPrice('custom', 2.45)).toBeNull();
    expect(validateLimitPrice('custom', 0.01)).toBeNull();
    // 0.07/0.01 is 6.999999999999999 in binary floating point — the naive
    // modulo rejects it, and it is a perfectly ordinary premium.
    expect(validateLimitPrice('custom', 0.07)).toBeNull();
    expect(validateLimitPrice('custom', 12.3)).toBeNull();
  });

  it('requires a price for custom and forbids one for everything else', () => {
    expect(validateLimitPrice('custom', undefined)).toMatch(/required/);
    expect(validateLimitPrice('mid', undefined)).toBeNull();
    expect(validateLimitPrice('market', undefined)).toBeNull();
    expect(validateLimitPrice('mid', 2.45)).toMatch(/only accepted/);
    expect(validateLimitPrice('market', 2.45)).toMatch(/only accepted/);
    expect(validateLimitPrice('bid', 2.45)).toMatch(/only accepted/);
  });

  it('rejects prices that are not finite positive numbers', () => {
    expect(validateLimitPrice('custom', Number.NaN)).toMatch(/finite/);
    expect(validateLimitPrice('custom', Number.POSITIVE_INFINITY)).toMatch(/finite/);
    expect(validateLimitPrice('custom', '2.45')).toMatch(/finite/);
    expect(validateLimitPrice('custom', 0)).toMatch(/between/);
    expect(validateLimitPrice('custom', -2.45)).toMatch(/between/);
  });

  it('rejects a pasted twenty-digit price', () => {
    expect(validateLimitPrice('custom', MAX_LIMIT_PRICE + 0.01)).toMatch(/between/);
    expect(validateLimitPrice('custom', 12345678901234)).toMatch(/between/);
  });

  it('rejects a price finer than the contract tick', () => {
    expect(validateLimitPrice('custom', 2.455)).toMatch(/ticks/);
    expect(validateLimitPrice('custom', 0.015)).toMatch(/ticks/);
    // Below the floor as well as off-tick; the bounds check reports first, and
    // either message is a refusal.
    expect(validateLimitPrice('custom', 0.001)).toMatch(/between/);
  });
});

describe('customPriceWarning', () => {
  it('says nothing about a price inside or near the spread', () => {
    expect(customPriceWarning('custom', quote, 2.46)).toBeNull();
    expect(customPriceWarning('custom', quote, 2.45)).toBeNull();
    // Paying up 20% on a fast contract is ordinary and must not warn, or the
    // warning becomes noise nobody reads.
    expect(customPriceWarning('custom', quote, 2.95)).toBeNull();
    expect(customPriceWarning('custom', quote, 2.0)).toBeNull();
  });

  it('warns about a misplaced decimal point in either direction', () => {
    expect(customPriceWarning('custom', quote, 24.5)).toMatch(/far above the current spread/);
    expect(customPriceWarning('custom', quote, 0.25)).toMatch(/far below the current spread/);
  });

  it('fires exactly at the margin the constant names', () => {
    const justInside = quote.ask * (1 + CUSTOM_PRICE_WARNING_MARGIN);
    expect(customPriceWarning('custom', quote, justInside)).toBeNull();
    expect(customPriceWarning('custom', quote, justInside + 0.01)).not.toBeNull();
  });

  it('quotes the spread it compared against, so the number can be checked', () => {
    expect(customPriceWarning('custom', quote, 24.5)).toContain('2.45 / 2.47');
    expect(customPriceWarning('custom', quote, 24.5)).toContain('24.5');
  });

  it('says nothing for the four variants that carry no typed price', () => {
    for (const type of ['bid', 'mid', 'ask', 'market'] as const) {
      expect(customPriceWarning(type, quote, 24.5)).toBeNull();
    }
  });

  it('says nothing when the quote itself is unusable', () => {
    // A crossed or empty book gives nothing to compare against; the limit
    // resolution refuses those separately.
    expect(customPriceWarning('custom', { bid: 0, ask: 0, last: 0 }, 24.5)).toBeNull();
    expect(customPriceWarning('custom', { bid: 3, ask: 2, last: 2.5 }, 24.5)).toBeNull();
  });
});
