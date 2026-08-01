// Canonical spec: docs/apple-intelligence/implementation-plan.md Phase 5
// (position lifecycle analysis) and lifecycle-and-concurrency.md
// (position-critical priority and preemption). Connects TradeStore's
// position state to the analysis pipeline: availability gate → lifecycle
// diff → snapshot build → position-critical submit. Read-only over domain
// state; advisory only — no order construction or mutation of any kind.
import type { OptionContract } from '@0dtetrader/shared-types';
import type { ChartStore } from '../chart/ChartStore';
import type { TradeStore } from '../trade/TradeStore';
import type { AnalysisStore } from './AnalysisStore';
import { buildAnalysisSnapshot } from './AnalysisSnapshotBuilder';
import {
  evaluatePositionEvents,
  initialPositionWatchState,
  type PositionWatchState,
} from './PositionTriggerPolicy';

export interface PositionWiringDeps {
  tradeStore: Pick<TradeStore, 'subscribe' | 'getState'>;
  chartStore: Pick<ChartStore, 'getState'>;
  analysisStore: Pick<AnalysisStore, 'getState' | 'analyze'>;
  getSelectedContract?: () => OptionContract | null;
}

/**
 * Subscribes position lifecycle analysis to trade state. Returns an
 * unsubscribe function. The watch state always advances — even while the
 * model is not ready — so a change observed during unavailability never
 * fires retroactively once the model recovers.
 */
export function connectPositionAnalysis(deps: PositionWiringDeps): () => void {
  let watch: PositionWatchState = initialPositionWatchState(deps.tradeStore.getState().positions);

  return deps.tradeStore.subscribe(() => {
    const positions = deps.tradeStore.getState().positions;
    const evaluated = evaluatePositionEvents(watch, positions);
    watch = evaluated.state;
    if (evaluated.events.length === 0) return;
    if (deps.analysisStore.getState().availability.state !== 'ready') return;

    for (const event of evaluated.events) {
      const snapshot = buildAnalysisSnapshot({
        chart: deps.chartStore.getState(),
        positions,
        selectedContract: deps.getSelectedContract?.() ?? null,
        // A closed position no longer exists: build without position data
        // so the management-task evidence rule downgrades the analysis to
        // observation-only instead of reasoning about a phantom position.
        triggeredPosition: event.kind === 'position-close' ? null : event.position,
        trigger: { kind: event.triggerKind, priority: 'position-critical', reason: event.reason },
      });
      void deps.analysisStore.analyze(snapshot, 'position-critical');
    }
  });
}
