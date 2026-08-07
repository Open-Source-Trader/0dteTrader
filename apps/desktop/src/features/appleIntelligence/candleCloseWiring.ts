// Canonical spec: docs/apple-intelligence/implementation-plan.md Phase 4
// (automatic completed-candle analysis) and lifecycle-and-concurrency.md.
// Connects ChartStore's narrow candle-close hook to the analysis pipeline:
// availability gate → trigger policy → snapshot build → scheduler submit.
// Read-only over domain state; owns nothing but its per-chart dedupe state.
import type { OptionContract, Position } from '@0dtetrader/shared-types';
import type { CandleCloseEvent, ChartStore } from '../chart/ChartStore';
import type { AnalysisStore } from './AnalysisStore';
import { buildAnalysisSnapshot } from './AnalysisSnapshotBuilder';
import { evaluateCandleCloseTrigger, type CandleCloseTriggerState } from './AnalysisTriggerPolicy';

export interface CandleCloseWiringDeps {
  chartStore: Pick<ChartStore, 'onCandleClose' | 'getState'>;
  analysisStore: Pick<AnalysisStore, 'getState' | 'submitCandleClose'>;
  getPositions: () => Position[];
  getSelectedContract?: () => OptionContract | null;
}

/**
 * Subscribes automatic candle-close analysis to the chart. Returns an
 * unsubscribe function. Skips entirely (no queueing, no error surface)
 * while the model is not ready, and fires at most once per distinct
 * candle close per symbol+timeframe via the trigger policy.
 */
export function connectCandleCloseAnalysis(deps: CandleCloseWiringDeps): () => void {
  const triggerStates = new Map<string, CandleCloseTriggerState>();

  return deps.chartStore.onCandleClose((event: CandleCloseEvent) => {
    if (deps.analysisStore.getState().availability.state !== 'ready') return;

    const key = `${event.symbol}:${event.interval}`;
    const state = triggerStates.get(key) ?? { lastTriggeredCloseTime: null };
    const decision = evaluateCandleCloseTrigger(
      { symbol: event.symbol, timeframe: event.interval, candleCloseTime: event.closeTime },
      state,
    );
    if (!decision.shouldTrigger) return;
    triggerStates.set(key, { lastTriggeredCloseTime: event.closeTime });

    const snapshot = buildAnalysisSnapshot({
      chart: deps.chartStore.getState(),
      positions: deps.getPositions(),
      selectedContract: deps.getSelectedContract?.() ?? null,
      trigger: { kind: 'candle-close', priority: 'candle-close', reason: decision.reason },
    });
    void deps.analysisStore.submitCandleClose(snapshot);
  });
}
