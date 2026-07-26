import { describe, expect, it } from 'vitest';
import { PRICE_MAX, isPriceInputShape, parsePriceInput, roundToTick } from './priceInput';

/**
 * Mirrors `PlacementGuideTests.swift`'s level-input cases. The rule these both
 * encode: accept the part-typed forms a price passes through on the way in, and
 * only *report* a price when the text actually names one.
 */
describe('isPriceInputShape', () => {
  it('accepts the part-typed forms a price passes through', () => {
    for (const text of ['', '.', '0', '4300.', '4300.5', '2.45']) {
      expect(isPriceInputShape(text)).toBe(true);
    }
  });

  it('rejects everything Number would otherwise read as a price', () => {
    for (const text of ['1e5', '0x1f', 'Infinity', '-3', ' 42 ', '2.4.5', '2,45']) {
      expect(isPriceInputShape(text)).toBe(false);
    }
  });
});

describe('parsePriceInput', () => {
  it('names no price while the text is still being typed', () => {
    // A cleared field parses to 0, which is finite and passes every other
    // guard — the caller must not be able to submit it.
    for (const text of ['', '.', '0', '0.00']) {
      expect(parsePriceInput(text)).toBeNull();
    }
  });

  it('reports a price as soon as the text names one', () => {
    expect(parsePriceInput('2.45')).toBe(2.45);
    expect(parsePriceInput('0.01')).toBe(0.01);
    // `'4300.'` parses fine, which is exactly why the field must keep the raw
    // draft rather than re-rendering the canonical string mid-word.
    expect(parsePriceInput('4300.')).toBe(4300);
  });

  it('refuses a pasted twenty-digit price', () => {
    expect(parsePriceInput(String(PRICE_MAX + 1))).toBeNull();
    expect(parsePriceInput('12345678901234')).toBeNull();
  });
});

describe('roundToTick', () => {
  it('lands exactly on the cent the server checks for', () => {
    expect(roundToTick(2.456)).toBe(2.46);
    expect(roundToTick(2.454)).toBe(2.45);
    // Divide-and-multiply by 0.01 gives 2.4500000000000002 here, which the
    // server's tick check rejects.
    expect(roundToTick(2.45)).toBe(2.45);
  });
});
