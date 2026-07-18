import { describe, expect, it } from 'vitest';
import { midPrice } from './domain';

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
