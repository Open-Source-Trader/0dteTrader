import { describe, expect, it } from 'vitest';
import { narrowToChartOrderType } from '@0dtetrader/shared-types';
import { midPrice, orderPricingDescription, orderTypeDisplayName } from './domain';

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
