import { describe, expect, it, vi } from 'vitest';
import { applySeriesDataLifecycle, seriesLifecycleAction } from './seriesDataLifecycle';

describe('seriesLifecycleAction', () => {
  it('replaces a series when a parameter change modifies historical values', () => {
    const previous = [
      { time: 1, value: 10 },
      { time: 2, value: 11 },
      { time: 3, value: 12 },
    ];
    const next = [
      { time: 1, value: 20 },
      { time: 2, value: 21 },
      { time: 3, value: 22 },
    ];

    expect(seriesLifecycleAction(previous, next)).toBe('setData');
  });

  it('uses an incremental update when only the forming point changes', () => {
    const previous = [
      { time: 1, value: 10 },
      { time: 2, value: 11 },
      { time: 3, value: 12 },
    ];
    const next = [
      { time: 1, value: 10 },
      { time: 2, value: 11 },
      { time: 3, value: 12.5 },
    ];

    expect(seriesLifecycleAction(previous, next)).toBe('update');
  });

  it('replaces equal-length data when the final timestamp moves', () => {
    const previous = [{ time: 1, value: 10 }];
    const next = [{ time: 2, value: 10 }];

    expect(seriesLifecycleAction(previous, next)).toBe('setData');
  });

  it('replaces histogram history when either values or per-point colors change', () => {
    const previous = [
      { time: 1, value: 2, color: '#00ff00' },
      { time: 2, value: -1, color: '#ff0000' },
    ];

    expect(
      seriesLifecycleAction(previous, [{ time: 1, value: -2, color: '#ff0000' }, previous[1]]),
    ).toBe('setData');
  });

  it('invalidates both rendered boundaries when a band parameter changes', () => {
    const upperBefore = [
      { time: 1, value: 12 },
      { time: 2, value: 13 },
    ];
    const lowerBefore = [
      { time: 1, value: 8 },
      { time: 2, value: 9 },
    ];
    const upperAfter = [
      { time: 1, value: 14 },
      { time: 2, value: 15 },
    ];
    const lowerAfter = [
      { time: 1, value: 6 },
      { time: 2, value: 7 },
    ];

    expect(seriesLifecycleAction(upperBefore, upperAfter)).toBe('setData');
    expect(seriesLifecycleAction(lowerBefore, lowerAfter)).toBe('setData');
  });

  it('executes the renderer setData/update lifecycle selected for real series APIs', () => {
    const setData = vi.fn();
    const update = vi.fn();
    const previous = [
      { time: 1, value: 10 },
      { time: 2, value: 11 },
    ];

    applySeriesDataLifecycle(previous, [{ time: 1, value: 20 }, previous[1]], {
      setData,
      update,
    });
    expect(setData).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();

    setData.mockClear();
    applySeriesDataLifecycle(previous, [previous[0], { time: 2, value: 12 }], {
      setData,
      update,
    });
    expect(setData).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
  });
});
