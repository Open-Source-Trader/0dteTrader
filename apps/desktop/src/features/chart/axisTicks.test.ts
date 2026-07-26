import { describe, expect, it } from 'vitest';
import { formatTick, priceTicks, timeTickIndices } from './axisTicks';

describe('priceTicks', () => {
  it('picks round levels inside the range', () => {
    const { values, decimals } = priceTicks(683.4, 685.0, 6);
    expect(values).toEqual([683.5, 684, 684.5, 685]);
    expect(decimals).toEqual(1);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(683.4);
    expect(Math.max(...values)).toBeLessThanOrEqual(685.0);
  });

  it('keeps a fractional step on its round values across a long span', () => {
    const { values } = priceTicks(0, 100, 4);
    expect(values).toEqual([0, 25, 50, 75, 100]);
  });

  it('scales the decimals to the step', () => {
    expect(priceTicks(100, 500, 5).decimals).toEqual(0);
    expect(priceTicks(1.0, 1.05, 5).decimals).toEqual(2);
  });

  it('returns nothing for a degenerate range', () => {
    expect(priceTicks(5, 5, 6).values).toEqual([]);
    expect(priceTicks(Number.NaN, 10, 6).values).toEqual([]);
  });
});

describe('timeTickIndices', () => {
  it('spaces indices across the visible window', () => {
    expect(timeTickIndices(0, 50, 100, 5)).toEqual([0, 10, 20, 30, 40, 50]);
  });

  it('clamps to the bars that exist', () => {
    expect(timeTickIndices(-8, 40, 12, 4)).toEqual([0, 3, 6, 9]);
  });

  it('returns nothing when the window is past the data', () => {
    expect(timeTickIndices(20, 30, 10, 5)).toEqual([]);
    expect(timeTickIndices(0, 10, 0, 5)).toEqual([]);
  });
});

describe('formatTick', () => {
  it('prints clock time intraday and month/day daily', () => {
    const noon = new Date(2026, 6, 26, 13, 5).getTime() / 1000;
    expect(formatTick(noon, '1m')).toEqual('13:05');
    expect(formatTick(noon, '1d')).toEqual('7/26');
  });
});
