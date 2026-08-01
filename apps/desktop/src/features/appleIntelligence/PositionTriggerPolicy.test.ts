import { describe, expect, it } from 'vitest';
import type { Position } from '@0dtetrader/shared-types';
import {
  evaluatePositionEvents,
  initialPositionWatchState,
  MATERIAL_PNL_SHIFT_PERCENT,
} from './PositionTriggerPolicy';

function position(overrides: Partial<Position> = {}): Position {
  return {
    symbol: 'SPY260731C00500000',
    assetClass: 'OPTION',
    quantity: 2,
    avgPrice: 1.25,
    markPrice: 1.25,
    unrealizedPnl: 0,
    multiplier: 100,
    ...overrides,
  } as Position;
}

describe('evaluatePositionEvents', () => {
  it('fires position-open when a new symbol appears', () => {
    const state = initialPositionWatchState([]);
    const { events } = evaluatePositionEvents(state, [position()]);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('position-open');
    expect(events[0].triggerKind).toBe('position-change');
    expect(events[0].reason).toContain('qty 2');
  });

  it('fires position-scale when quantity changes', () => {
    const state = initialPositionWatchState([position()]);
    const { events } = evaluatePositionEvents(state, [position({ quantity: 5 })]);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('position-scale');
    expect(events[0].reason).toContain('2 → 5');
  });

  it('fires position-close with the prior position when a symbol disappears', () => {
    const held = position();
    const state = initialPositionWatchState([held]);
    const { events, state: next } = evaluatePositionEvents(state, []);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('position-close');
    expect(events[0].position).toBe(held);
    expect(next.pnlBaselines.has(held.symbol)).toBe(false);
  });

  it('does not fire on an unchanged position with minor P&L drift', () => {
    const state = initialPositionWatchState([position()]);
    // 10% of the 250 cost basis — under the material threshold.
    const { events } = evaluatePositionEvents(state, [
      position({ markPrice: 1.375, unrealizedPnl: 25 }),
    ]);

    expect(events).toEqual([]);
  });

  it('fires material-change when P&L drifts past the threshold, then rebaselines', () => {
    const state = initialPositionWatchState([position()]);
    // Cost basis 1.25 * 2 * 100 = 250; -75 is -30% — past the 25pt threshold.
    const first = evaluatePositionEvents(state, [
      position({ markPrice: 0.875, unrealizedPnl: -75 }),
    ]);

    expect(first.events).toHaveLength(1);
    expect(first.events[0].kind).toBe('material-change');
    expect(first.events[0].triggerKind).toBe('material-change');

    // Same P&L again: baseline moved, so no repeat trigger.
    const second = evaluatePositionEvents(first.state, [
      position({ markPrice: 0.875, unrealizedPnl: -75 }),
    ]);
    expect(second.events).toEqual([]);
  });

  it('exposes the threshold as percentage points of cost basis', () => {
    expect(MATERIAL_PNL_SHIFT_PERCENT).toBe(25);
  });

  it('handles multiple simultaneous events across symbols', () => {
    const closing = position({ symbol: 'OLD' });
    const state = initialPositionWatchState([closing]);
    const { events } = evaluatePositionEvents(state, [position({ symbol: 'NEW' })]);

    const kinds = events.map((e) => e.kind).sort();
    expect(kinds).toEqual(['position-close', 'position-open']);
  });

  it('treats a zero cost basis as zero P&L percent instead of dividing by zero', () => {
    const free = position({ avgPrice: 0, unrealizedPnl: 50 });
    const state = initialPositionWatchState([free]);
    const { events } = evaluatePositionEvents(state, [{ ...free, unrealizedPnl: 5000 }]);

    expect(events).toEqual([]);
  });
});
