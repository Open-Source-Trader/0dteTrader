// Canonical spec: docs/apple-intelligence/architecture.md
// (AnalysisTriggerPolicy — "pure decision logic") and implementation-plan.md
// Phase 4 ("pure trigger policy for completed candles... do not trigger on
// every quote"). Pure functions only: no timers, no IPC, no store reads.
import type { TriggerPriority } from './types';

export interface CandleCloseEvent {
  symbol: string;
  timeframe: string;
  /** Epoch seconds of the candle's close/bucket-start time — identifies
   * *which* candle closed, so the same close is never triggered twice. */
  candleCloseTime: number;
}

export interface CandleCloseTriggerState {
  /** The candleCloseTime last triggered for this exact symbol+timeframe,
   * or null if no automatic trigger has fired yet this session. */
  lastTriggeredCloseTime: number | null;
}

export interface TriggerDecision {
  shouldTrigger: boolean;
  priority: TriggerPriority;
  reason: string;
}

/**
 * Decides whether a newly-closed candle should trigger automatic analysis.
 * Fires at most once per distinct candle close per symbol+timeframe — never
 * on intra-candle ticks, since the caller only calls this on an actual
 * candle-close transition, not on every quote update.
 */
export function evaluateCandleCloseTrigger(
  event: CandleCloseEvent,
  state: CandleCloseTriggerState,
): TriggerDecision {
  if (state.lastTriggeredCloseTime === event.candleCloseTime) {
    return {
      shouldTrigger: false,
      priority: 'candle-close',
      reason: 'already triggered for this candle close',
    };
  }
  return {
    shouldTrigger: true,
    priority: 'candle-close',
    reason: `candle closed at ${event.candleCloseTime} for ${event.symbol} ${event.timeframe}`,
  };
}
