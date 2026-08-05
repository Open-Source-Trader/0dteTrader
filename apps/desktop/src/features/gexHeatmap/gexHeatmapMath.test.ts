import { describe, expect, it } from 'vitest';
import {
  formatGexValue,
  getClosestStrike,
  getGexCellStyle,
  getMaxAbsoluteValue,
  selectStrikesAroundSpot,
  sortEntriesByStrikeDescending,
} from './gexHeatmapMath';
import type { GexHeatmapEntry } from './types';

function entry(strike: number, netGex: number | null, expiration = '2026-08-21'): GexHeatmapEntry {
  return { strike, cells: [{ expiration, netGex }] };
}

describe('formatGexValue', () => {
  it('formats positive values with a leading plus and a dollar sign', () => {
    expect(formatGexValue(54_700_000)).toBe('+$54,700,000');
  });

  it('formats negative values with a leading minus', () => {
    expect(formatGexValue(-12_400_000)).toBe('-$12,400,000');
  });

  it('formats zero as unsigned', () => {
    expect(formatGexValue(0)).toBe('$0');
  });

  it('normalizes negative zero to positive zero', () => {
    expect(formatGexValue(-0)).toBe('$0');
  });

  it('formats null as a dash', () => {
    expect(formatGexValue(null)).toBe('-');
  });
});

describe('getMaxAbsoluteValue', () => {
  it('finds the largest absolute netGex across every cell in every entry', () => {
    const entries = [entry(750, 50_500_000), entry(770, -70_000_000)];
    expect(getMaxAbsoluteValue(entries)).toBe(70_000_000);
  });

  it('ignores null values', () => {
    const entries = [entry(750, null)];
    expect(getMaxAbsoluteValue(entries)).toBe(0);
  });

  it('returns 0 for an all-null dataset', () => {
    expect(getMaxAbsoluteValue([entry(750, null), entry(760, null)])).toBe(0);
  });
});

describe('getGexCellStyle', () => {
  it('clamps intensity at 1 when value exceeds the maximum', () => {
    const atMax = getGexCellStyle(100, 100);
    const overMax = getGexCellStyle(200, 100);
    expect(overMax.background).toBe(atMax.background);
  });

  it('produces a positive (green) style for positive values', () => {
    const style = getGexCellStyle(50, 100);
    expect(style.borderColor).toContain('0, 220, 34');
  });

  it('produces a negative (red) style for negative values', () => {
    const style = getGexCellStyle(-50, 100);
    expect(style.borderColor).toContain('210, 20, 45');
  });

  it('renders near-zero magnitudes with lower intensity than large ones', () => {
    const near = getGexCellStyle(1, 1000);
    const far = getGexCellStyle(999, 1000);
    expect(near.background).not.toBe(far.background);
  });
});

describe('sortEntriesByStrikeDescending', () => {
  it('sorts a copy, highest strike first, without mutating the input', () => {
    const entries = [entry(750, 1), entry(780, 1), entry(765, 1)];
    const original = [...entries];
    const sorted = sortEntriesByStrikeDescending(entries);
    expect(sorted.map((e) => e.strike)).toEqual([780, 765, 750]);
    expect(entries).toEqual(original);
  });
});

describe('getClosestStrike', () => {
  it('selects the closest strike to spot', () => {
    const entries = [entry(750, 1), entry(760, 1), entry(770, 1), entry(780, 1)];
    expect(getClosestStrike(entries, 771.7)).toBe(770);
  });

  it('returns null for an empty entries list', () => {
    expect(getClosestStrike([], 100)).toBeNull();
  });
});

describe('selectStrikesAroundSpot', () => {
  it('returns 10 strikes above and 10 below the closest strike, plus itself', () => {
    const entries = Array.from({ length: 41 }, (_, i) => entry(700 + i * 5, 1));
    const spotPrice = 700 + 20 * 5; // exact middle strike
    const window = selectStrikesAroundSpot(entries, spotPrice);
    expect(window).toHaveLength(21);
    expect(window[0].strike).toBe(700 + 10 * 5);
    expect(window[window.length - 1].strike).toBe(700 + 30 * 5);
  });

  it('clamps the window at the edges of the available strikes', () => {
    const entries = Array.from({ length: 5 }, (_, i) => entry(700 + i * 5, 1));
    const window = selectStrikesAroundSpot(entries, 700);
    expect(window).toHaveLength(5);
  });

  it('returns an empty list for no entries', () => {
    expect(selectStrikesAroundSpot([], 100)).toHaveLength(0);
  });
});
