import { useEffect, useState } from 'react';
import { useStore } from '../../core/observable';
import type { AnalysisStore } from './AnalysisStore';
import type { AnalysisSnapshot } from './types';

interface AIAnalysisButtonProps {
  analysisStore: AnalysisStore;
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
 */
export function AIAnalysisButton({ analysisStore, buildSnapshot }: AIAnalysisButtonProps) {
  const state = useStore(analysisStore);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    analysisStore.start();
    void analysisStore.refreshAvailability();
    return () => analysisStore.stop();
  }, [analysisStore]);

  const isUnavailable = state.availability.state !== 'ready';

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
              {state.errorMessage ? (
                <p className="text-secondary" role="alert">
                  {state.errorMessage}
                </p>
              ) : null}
              {state.latestResult ? (
                <div>
                  <p>
                    <strong>{state.latestResult.recommendation.toUpperCase()}</strong> ·{' '}
                    {state.latestResult.bias} · confidence{' '}
                    {Math.round(state.latestResult.confidence * 100)}%
                  </p>
                  <p>{state.latestResult.summary}</p>
                  {state.latestResult.warnings.length > 0 ? (
                    <ul>
                      {state.latestResult.warnings.map((warning) => (
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
