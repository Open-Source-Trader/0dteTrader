import { useMemo, useState } from 'react';
import type { OptionContract } from '@0dtetrader/shared-types';
import { useStore, shallowEqual } from '../../core/observable';
import type { AnalysisStore } from './AnalysisStore';
import { hashPositionVersion } from './AnalysisSnapshotBuilder';
import { buildTradeDeskViewState } from './tradeDeskPresenter';
import type { AnalysisSnapshot, TriggerKind } from './types';
import type { TradeStore } from '../trade/TradeStore';

const TRIGGER_LABELS: Record<Exclude<TriggerKind, 'manual'>, string> = {
  'candle-close': 'candle close',
  'position-change': 'position change',
  'material-change': 'material P&L change',
};

interface AIAnalysisButtonProps {
  analysisStore: AnalysisStore;
  tradeStore: TradeStore;
  selectedContract: OptionContract | null;
  /** Builds a fresh snapshot from current domain state at click time —
   * the button never holds its own copy of trading state. */
  buildSnapshot: () => AnalysisSnapshot;
}

/**
 * Minimal manual-invocation entry point (implementation-plan.md Phase 3):
 * a floating button that requests one analysis and shows the result in a
 * small panel. Self-positioned so it can mount once regardless of which of
 * TradeScreen's three layout variants is active, instead of threading props
 * through ChartView across all of them.
 *
 * Does not own the AnalysisStore event subscription — TradeScreen calls
 * start()/refreshAvailability() once for the screen's full lifetime,
 * independent of which layout (and therefore which AI entry point,
 * AIAnalysisButton or TradeDeskPanel) is currently rendered.
 */
export function AIAnalysisButton({
  analysisStore,
  tradeStore,
  selectedContract,
  buildSnapshot,
}: AIAnalysisButtonProps) {
  const state = useStore(analysisStore);
  const trade = useStore(tradeStore, (s) => ({ positions: s.positions }), shallowEqual);
  const [isOpen, setIsOpen] = useState(false);

  const isUnavailable = state.availability.state !== 'ready';

  const currentPositionVersion = useMemo(() => {
    if (!selectedContract) return 0;
    const position = trade.positions.find(
      (candidate) => candidate.symbol === selectedContract.symbol,
    );
    return position ? hashPositionVersion(position) : 0;
  }, [selectedContract, trade.positions]);

  const currentContext = useMemo(() => {
    const latest = state.latestResult?.context;
    if (!latest) return null;
    return {
      ...latest,
      selectedContractSymbol: selectedContract?.symbol,
      positionVersion: currentPositionVersion,
    };
  }, [state.latestResult, selectedContract, currentPositionVersion]);

  // Presentation is the same single source of truth TradeDeskPanel uses:
  // it applies action-invariant downgrading (validation.ts) and the
  // decision-bearing fields consistently, so this button can't show a
  // stale action next to a "Downgraded from ..." warning the way reading
  // state.latestResult.recommendation directly once did.
  const viewState = useMemo(
    () =>
      buildTradeDeskViewState({
        availability: state.availability,
        isAnalyzing: state.isAnalyzing,
        latestResult: state.latestResult,
        lastDiscard: state.lastDiscard,
        pendingActionChange: state.pendingActionChange,
        currentContext,
        selectedContract,
        currentPositionVersion,
      }),
    [state, currentContext, selectedContract, currentPositionVersion],
  );
  const presentation = viewState.presentation;

  return (
    // Top-right, clear of the chart's own top-right controls (symbol
    // search, indicator settings icons live top-left/inline; the chain
    // table and "Expand" positions-footer toggle own the bottom-right
    // corner) — see TradeScreen.tsx for the surrounding layout.
    <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 20 }}>
      {isOpen ? (
        <div
          role="dialog"
          aria-label="AI analysis"
          style={{
            marginTop: 8,
            width: 320,
            maxHeight: 420,
            overflowY: 'auto',
            background: 'var(--surface-2, #16181c)',
            border: '1px solid var(--hud-stroke-dim)',
            borderRadius: 8,
            padding: 12,
            fontSize: 'var(--fs-caption)',
          }}
        >
          {isUnavailable ? (
            <p className="text-secondary">
              Apple Intelligence is unavailable
              {state.availability.state !== 'ready' && 'reason' in state.availability
                ? `: ${state.availability.reason}`
                : ''}
              .
            </p>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void analysisStore.analyze(buildSnapshot())}
                disabled={state.isAnalyzing}
                style={{ marginBottom: 8 }}
              >
                {state.isAnalyzing ? 'Analyzing…' : 'Analyze'}
              </button>
              {state.isAnalyzing ? (
                <button type="button" onClick={() => void analysisStore.cancel()}>
                  Cancel
                </button>
              ) : null}
              {state.lastDiscard ? (
                <p className="text-secondary" role="alert">
                  {state.lastDiscard.message}
                </p>
              ) : null}
              {presentation ? (
                <div>
                  {state.latestTriggerKind && state.latestTriggerKind !== 'manual' ? (
                    // Advisory-only label for automatic results: the app
                    // never acts on analysis; the user always does.
                    <p className="text-secondary">
                      Auto-generated ({TRIGGER_LABELS[state.latestTriggerKind]}) — advisory only.
                    </p>
                  ) : null}
                  <p>
                    <strong>{presentation.actionLabel}</strong>
                    {presentation.confidence ? ` · confidence ${presentation.confidence}` : ''}
                  </p>
                  <p>{presentation.summary}</p>
                  {presentation.warnings.length > 0 ? (
                    <ul>
                      {presentation.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-label="AI analysis"
        aria-pressed={isOpen}
      >
        AI
      </button>
    </div>
  );
}
