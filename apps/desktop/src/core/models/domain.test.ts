import { describe, expect, it } from 'vitest';
import { narrowToChartOrderType } from '@0dtetrader/shared-types';
import {
  midPrice,
  orderPricingDescription,
  orderStatusHistoryLabel,
  orderTypeDisplayName,
  quotesPending,
} from './domain';

describe('midPrice — every successful midpoint is finite', () => {
  it.each([
    [1.0, Number.POSITIVE_INFINITY],
    [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    [Number.NEGATIVE_INFINITY, 1.0],
    // FINITE operands whose sum overflows — the round-9 fix checked only the
    // operands and let these through as an infinite midpoint.
    [1e308, 1e308],
    [Number.MAX_VALUE, Number.MAX_VALUE],
  ])('returns null rather than arithmetic on an unusable book (%s, %s)', (bid, ask) => {
    expect(midPrice(bid, ask)).toBeNull();
  });

  it('prices the exact ceiling and refuses one tick past it', () => {
    expect(midPrice(99_999.99, 100_000)).not.toBeNull();
    expect(midPrice(100_000, 100_000.01)).toBeNull();
  });

  it('never returns a non-finite or above-cap number for any book it accepts', () => {
    const books = [
      [1.0, 1.04],
      [1.0, 1.0],
      [0.01, 0.02],
      [99_999.99, 100_000],
    ] as const;
    for (const [bid, ask] of books) {
      const mid = midPrice(bid, ask);
      expect(mid).not.toBeNull();
      expect(Number.isFinite(mid)).toBe(true);
      expect(mid as number).toBeLessThanOrEqual(100_000);
    }
  });
});

describe('midPrice', () => {
  it('averages bid and ask rounded to pennies', () => {
    expect(midPrice(1.0, 1.04)).toBe(1.02);
    expect(midPrice(4.8, 5.0)).toBe(4.9);
  });

  it('supports custom precision', () => {
    expect(midPrice(6000.75, 6001.25, 4)).toBe(6001);
  });

  it('allows a locked market (bid === ask)', () => {
    expect(midPrice(2.5, 2.5)).toBe(2.5);
  });

  it('returns null for zero or negative sides', () => {
    expect(midPrice(0, 0)).toBeNull();
    expect(midPrice(0, 1.05)).toBeNull();
    expect(midPrice(1.0, 0)).toBeNull();
    expect(midPrice(-1, 2)).toBeNull();
  });

  it('returns null for a crossed spread', () => {
    expect(midPrice(1.1, 1.0)).toBeNull();
  });

  it('returns null for NaN inputs', () => {
    expect(midPrice(Number.NaN, 1.0)).toBeNull();
    expect(midPrice(1.0, Number.NaN)).toBeNull();
  });
});

describe('narrowToChartOrderType', () => {
  it('collapses every priced variant onto mid', () => {
    // A line fires unattended: a bid/ask read now would be stale by the time
    // the level is crossed, and a custom price belongs to the moment it was
    // typed. Only Market survives as itself.
    expect(narrowToChartOrderType('custom')).toBe('mid');
    expect(narrowToChartOrderType('bid')).toBe('mid');
    expect(narrowToChartOrderType('mid')).toBe('mid');
    expect(narrowToChartOrderType('ask')).toBe('mid');
    expect(narrowToChartOrderType('market')).toBe('market');
  });
});

describe('order-type labels', () => {
  it('names all five', () => {
    expect(orderTypeDisplayName('custom')).toBe('Custom');
    expect(orderTypeDisplayName('bid')).toBe('Bid');
    expect(orderTypeDisplayName('ask')).toBe('Ask');
    expect(orderPricingDescription('custom')).toBe('Limit at your price');
    expect(orderPricingDescription('ask')).toBe('Limit at ask');
    expect(orderPricingDescription('market')).toBe('Market');
  });

  it('prints an unrecognised stored value as it came', () => {
    // History rows predate this union and are read back as raw strings.
    expect(orderTypeDisplayName('limit')).toBe('limit');
  });
});

describe('orderStatusHistoryLabel', () => {
  it('renders resting orders as Waiting (display only; wire values unchanged)', () => {
    expect(orderStatusHistoryLabel('submitted')).toBe('Waiting');
    expect(orderStatusHistoryLabel('partially_filled')).toBe('Waiting · partial fill');
  });

  it('leaves terminal and unknown statuses on the shared display names', () => {
    expect(orderStatusHistoryLabel('filled')).toBe('Filled');
    expect(orderStatusHistoryLabel('cancelled')).toBe('Cancelled');
    expect(orderStatusHistoryLabel('rejected')).toBe('Rejected');
    expect(orderStatusHistoryLabel('weird_broker_state')).toBe('Unknown');
  });
});

describe('quotesPending — one readiness matrix for every order type', () => {
  const contract = (bid: number, ask: number, last = 0) =>
    ({
      symbol: 'SPY260717C00505000',
      underlying: 'SPY',
      expiration: '2026-07-17',
      strike: 505,
      optionType: 'call',
      bid,
      ask,
      last,
    }) as never;

  it('accepts a two-sided, non-crossed book', () => {
    expect(quotesPending(contract(1.0, 1.1))).toBe(false);
  });

  it('accepts a LOCKED book — bid equal to ask is legal', () => {
    expect(quotesPending(contract(1.0, 1.0))).toBe(false);
  });

  it('accepts the exact ceiling, and every accepted book prices finitely in range', () => {
    // The invariant the ceiling exists for: readiness and price resolution
    // must agree, so any book that reads as ready yields a finite mid ≤ cap.
    const ready: Array<[number, number]> = [
      [1.0, 1.1],
      [99_999.99, 100_000],
    ];
    for (const [bid, ask] of ready) {
      expect(quotesPending(contract(bid, ask))).toBe(false);
      const mid = midPrice(bid, ask);
      expect(mid).not.toBeNull();
      expect(Number.isFinite(mid)).toBe(true);
      expect(mid as number).toBeLessThanOrEqual(100_000);
    }
  });

  it.each([
    ['bid-only', 1.0, 0],
    ['ask-only', 0, 1.1],
    ['zero both', 0, 0],
    ['crossed', 1.2, 1.0],
    ['NaN bid', Number.NaN, 1.1],
    ['NaN ask', 1.0, Number.NaN],
    ['negative bid', -0.05, 1.1],
    ['infinite ask', 1.0, Number.POSITIVE_INFINITY],
    ['infinite bid', Number.POSITIVE_INFINITY, 1.1],
    ['infinite both', Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    ['negative-infinite bid', Number.NEGATIVE_INFINITY, 1.1],
    ['huge-but-finite (midpoint would overflow)', 1e308, 1e308],
    ['above the shared ceiling', 100_000, 100_000.01],
  ])('refuses a %s book', (_label, bid, ask) => {
    expect(quotesPending(contract(bid as number, ask as number))).toBe(true);
  });

  it('refuses a last-only quote — an old print is not a book to price from', () => {
    expect(quotesPending(contract(0, 0, 1.05))).toBe(true);
  });

  it('treats no contract at all as not-pending (nothing selected to gate on)', () => {
    expect(quotesPending(null)).toBe(false);
  });
});

describe('price ceiling parity', () => {
  it('typed input, readiness and resolution all share one ceiling', async () => {
    const { PRICE_MAX } = await import('./priceInput');
    const { MAX_OPTION_PRICE } = await import('@0dtetrader/shared-types');
    expect(PRICE_MAX).toBe(MAX_OPTION_PRICE);
    // The iOS mirror (PriceMath.maxOptionPrice) hard-codes this number;
    // its own test pins it. Move one, move both.
    expect(MAX_OPTION_PRICE).toBe(100_000);
  });
});
