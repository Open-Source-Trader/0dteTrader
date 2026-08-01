// Canonical spec: docs/apple-intelligence/implementation-plan.md Phase 5
// (position-open, scale, material-change, and close triggers) and
// lifecycle-and-concurrency.md (position-critical priority). Pure decision
// logic: no timers, no store reads, no IPC — the wiring owns subscriptions.
import type { Position } from '@0dtetrader/shared-types';
import type { TriggerKind } from './types';

/** Unrealized P&L must move this many percentage points (of cost basis)
 * from the last-triggered baseline before an unchanged position counts as
 * a material change — mark-price drift below this is noise, not lifecycle. */
export const MATERIAL_PNL_SHIFT_PERCENT = 25;

export interface PositionLifecycleEvent {
  kind: 'position-open' | 'position-scale' | 'position-close' | 'material-change';
  triggerKind: TriggerKind;
  symbol: string;
  reason: string;
  /** Position as of the event. For a close this is the last known (prior)
   * state — advisory context only; the position no longer exists. */
  position: Position;
}

export interface PositionWatchState {
  /** Last observed position per contract symbol. */
  positions: ReadonlyMap<string, Position>;
  /** P&L%-of-cost-basis baseline per symbol, reset whenever a lifecycle
   * event fires so material-change measures drift since the last trigger,
   * not since the last tick. */
  pnlBaselines: ReadonlyMap<string, number>;
}

export function initialPositionWatchState(positions: Position[]): PositionWatchState {
  const bySymbol = new Map(positions.map((p) => [p.symbol, p]));
  return {
    positions: bySymbol,
    pnlBaselines: new Map(positions.map((p) => [p.symbol, pnlPercent(p)])),
  };
}

/**
 * Diffs the previous watch state against the current positions list and
 * returns lifecycle events plus the next watch state. Open/scale/close are
 * structural; material-change fires only when P&L drifts more than
 * MATERIAL_PNL_SHIFT_PERCENT from the baseline set at the last event.
 */
export function evaluatePositionEvents(
  state: PositionWatchState,
  next: Position[],
): { events: PositionLifecycleEvent[]; state: PositionWatchState } {
  const events: PositionLifecycleEvent[] = [];
  const nextPositions = new Map(next.map((p) => [p.symbol, p]));
  const nextBaselines = new Map(state.pnlBaselines);

  for (const position of next) {
    const previous = state.positions.get(position.symbol);
    if (!previous) {
      events.push({
        kind: 'position-open',
        triggerKind: 'position-change',
        symbol: position.symbol,
        reason: `position opened: ${position.symbol} qty ${position.quantity} at avg ${position.avgPrice}`,
        position,
      });
      nextBaselines.set(position.symbol, pnlPercent(position));
      continue;
    }
    if (previous.quantity !== position.quantity) {
      events.push({
        kind: 'position-scale',
        triggerKind: 'position-change',
        symbol: position.symbol,
        reason: `position scaled: ${position.symbol} qty ${previous.quantity} → ${position.quantity}`,
        position,
      });
      nextBaselines.set(position.symbol, pnlPercent(position));
      continue;
    }
    const baseline = state.pnlBaselines.get(position.symbol) ?? pnlPercent(previous);
    const current = pnlPercent(position);
    if (Math.abs(current - baseline) >= MATERIAL_PNL_SHIFT_PERCENT) {
      events.push({
        kind: 'material-change',
        triggerKind: 'material-change',
        symbol: position.symbol,
        reason: `material P&L move: ${position.symbol} ${baseline.toFixed(1)}% → ${current.toFixed(1)}% of cost basis`,
        position,
      });
      nextBaselines.set(position.symbol, current);
    }
  }

  for (const [symbol, previous] of state.positions) {
    if (nextPositions.has(symbol)) continue;
    events.push({
      kind: 'position-close',
      triggerKind: 'position-change',
      symbol,
      reason: `position closed: ${symbol} qty ${previous.quantity} at avg ${previous.avgPrice}`,
      position: previous,
    });
    nextBaselines.delete(symbol);
  }

  return { events, state: { positions: nextPositions, pnlBaselines: nextBaselines } };
}

function pnlPercent(position: Position): number {
  const costBasis = Math.abs(position.avgPrice * position.quantity * position.multiplier);
  if (costBasis === 0) return 0;
  return (position.unrealizedPnl / costBasis) * 100;
}
