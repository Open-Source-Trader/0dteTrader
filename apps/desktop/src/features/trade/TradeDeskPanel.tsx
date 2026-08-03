import { useEffect, useMemo, useState } from 'react';
import type { OptionContract, Position } from '@0dtetrader/shared-types';
import { useStore, shallowEqual } from '../../core/observable';
import type { AnalysisSnapshot } from '../appleIntelligence/types';
import type { AnalysisStore } from '../appleIntelligence/AnalysisStore';
import { hashPositionVersion } from '../appleIntelligence/AnalysisSnapshotBuilder';
import { deriveMarketSessionState } from '../appleIntelligence/marketSessionState';
import {
  buildFlatTradeDeskAnalysis,
  buildPositionTradeDeskAnalysis,
  buildTradeDeskViewState,
  clampText,
  type FlatTradeDeskAnalysis,
  type PositionTradeDeskAnalysis,
  type TradeDeskGridCell,
  type TradeDeskPresentation,
  type TradeDeskViewState,
} from '../appleIntelligence/tradeDeskPresenter';
import type { ChainStore } from './ChainStore';
import type { TradeStore } from './TradeStore';

interface TradeDeskPanelProps {
  analysisStore: AnalysisStore;
  tradeStore: TradeStore;
  chainStore: ChainStore;
  selectedContract: OptionContract | null;
  buildSnapshot: () => AnalysisSnapshot;
  locked?: boolean;
  /** Quote socket connection state, from ChartStoreState.isStale — the
   * caller subscribes and passes this through rather than TradeDeskPanel
   * taking an optional ChartStore itself, since hooks can't be called
   * conditionally on an optional store. Defaults to false (assume live) for
   * callers that don't have chart state available. */
  isQuoteStreamStale?: boolean;
}

/** Fixed-height AI decision board beneath the chart. Always renders the same
 * 4x2 grid shape (flat or in-trade) and never scrolls — see
 * docs/plans (trading workspace redesign) for the layout contract this
 * enforces: structured fields only, bounded text, no chat-style expand. */
export function TradeDeskPanel({
  analysisStore,
  tradeStore,
  chainStore,
  selectedContract,
  buildSnapshot,
  locked = false,
  isQuoteStreamStale = false,
}: TradeDeskPanelProps) {
  const analysis = useStore(
    analysisStore,
    (state) => ({
      availability: state.availability,
      isAnalyzing: state.isAnalyzing,
      latestResult: state.latestResult,
      errorMessage: state.errorMessage,
      pendingActionChange: state.pendingActionChange,
    }),
    shallowEqual,
  );
  const trade = useStore(
    tradeStore,
    (state) => ({ positions: state.positions, isSubmitting: state.isSubmitting }),
    shallowEqual,
  );
  const [dismissedResultId, setDismissedResultId] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  const openPosition: Position | null = useMemo(() => {
    if (!selectedContract) return null;
    return (
      trade.positions.find(
        (candidate) => candidate.symbol === selectedContract.symbol && candidate.quantity > 0,
      ) ?? null
    );
  }, [selectedContract, trade.positions]);

  const currentPositionVersion = useMemo(
    () => (openPosition ? hashPositionVersion(openPosition) : 0),
    [openPosition],
  );

  const currentContext = useMemo(() => {
    const latest = analysis.latestResult?.context;
    if (!latest) return null;
    return {
      ...latest,
      selectedContractSymbol: selectedContract?.symbol,
      positionVersion: currentPositionVersion,
    };
  }, [analysis.latestResult, selectedContract, currentPositionVersion]);

  // isChainStale isn't tracked yet (AnalysisSnapshotBuilder always supplies
  // false for it — see its own comment); once it is, thread the same value
  // used to build the snapshot through here instead of hardcoding false.
  const marketSessionState = useMemo(
    () => deriveMarketSessionState({ isQuoteStreamStale, isChainStale: false }),
    [isQuoteStreamStale],
  );

  const viewState = useMemo(
    () =>
      buildTradeDeskViewState({
        ...analysis,
        currentContext,
        selectedContract,
        currentPositionVersion,
        dismissedResultId,
        disabled: locked,
        marketSessionState,
        hasOpenPosition: openPosition !== null,
      }),
    [
      analysis,
      currentContext,
      selectedContract,
      currentPositionVersion,
      dismissedResultId,
      locked,
      marketSessionState,
      openPosition,
    ],
  );

  useEffect(() => {
    if (viewState.presentation?.resultId !== dismissedResultId) setApplyError(null);
  }, [viewState.presentation?.resultId, dismissedResultId]);

  const refresh = () => {
    if (viewState.status === 'generating') return;
    void analysisStore.analyze(buildSnapshot());
  };

  const applySuggestedPrice = () => {
    setApplyError(null);
    if (viewState.status !== 'current' || !viewState.canApplySuggestedPrice) {
      setApplyError(
        viewState.status === 'stale' ? 'Refresh before applying.' : 'No current entry price.',
      );
      return;
    }
    const suggestion = viewState.presentation?.applicablePriceSuggestion;
    if (!suggestion) {
      setApplyError('No valid contract price suggestion.');
      return;
    }
    const result = tradeStore.applyTradeDeskPrice(
      { type: 'apply-trade-desk-price', suggestion },
      chainStore,
    );
    if (!result.ok) setApplyError(result.error);
  };

  const underlyingLast = useStore(
    chainStore,
    (state) => state.underlyingLast,
    (a, b) => a === b,
  );

  return (
    <section className={`trade-desk trade-desk--${viewState.status}`} aria-label="AI Trade Desk">
      <TradeDeskHeader viewState={viewState} onRefresh={refresh} />
      <TradeDeskBody
        viewState={viewState}
        selectedContract={selectedContract}
        position={openPosition}
        underlyingLast={underlyingLast}
        onApply={applySuggestedPrice}
        onRefresh={refresh}
        applyError={applyError}
        onDismiss={() =>
          viewState.presentation && setDismissedResultId(viewState.presentation.resultId)
        }
      />
    </section>
  );
}

function TradeDeskHeader({
  viewState,
  onRefresh,
}: {
  viewState: TradeDeskViewState;
  onRefresh: () => void;
}) {
  const age = useRelativeAge(viewState.generatedAt);
  const presentation = viewState.presentation;
  const label = statusLabel(viewState.status, viewState.marketSessionState);
  const freshnessLabel =
    viewState.status === 'current' && viewState.marketSessionState === 'live' && age
      ? `${label} · ${age}`
      : label;
  return (
    <div className="trade-desk__header">
      <span className="trade-desk__eyebrow">AI TRADE DESK</span>
      {presentation ? <TradeDeskActionBadge presentation={presentation} /> : null}
      {viewState.pendingActionChange ? (
        <span
          className="trade-desk__pending-action"
          title={`New signal: ${viewState.pendingActionChange.label} — confirming`}
        >
          → {viewState.pendingActionChange.label}?
        </span>
      ) : null}
      <span className="trade-desk__header-spacer" />
      {viewState.status === 'generating' && presentation ? (
        <span className="trade-desk__analyzing-dot" aria-hidden="true" />
      ) : null}
      <span className="trade-desk__position-state">
        {viewState.positionState === 'in-trade' ? 'IN TRADE' : 'FLAT'}
      </span>
      <span className="trade-desk__status" role="status" aria-live="polite">
        {freshnessLabel}
      </span>
      {viewState.status === 'failed' || viewState.status === 'unavailable' ? (
        <button type="button" className="trade-desk__header-action" onClick={onRefresh}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

function TradeDeskBody({
  viewState,
  selectedContract,
  position,
  underlyingLast,
  onApply,
  onRefresh,
  applyError,
  onDismiss,
}: {
  viewState: TradeDeskViewState;
  selectedContract: OptionContract | null;
  position: Position | null;
  underlyingLast: number | null;
  onApply: () => void;
  onRefresh: () => void;
  applyError: string | null;
  onDismiss: () => void;
}) {
  const presentation = viewState.presentation;

  if (!presentation) {
    // staleReason carries curated copy for `stale` (from staleReason() in
    // tradeDeskPresenter.ts) but can carry a raw AnalysisStore/IPC error
    // message for `failed` — never surface that verbatim, only a bounded,
    // generic diagnostic. Full detail belongs in logs, not this panel.
    const detail = placeholderDetail(viewState);
    return (
      <div className="trade-desk__placeholder" role="status">
        <span>{emptyStatusText(viewState)}</span>
        {detail ? <small>{detail}</small> : null}
      </div>
    );
  }

  if (viewState.positionState === 'in-trade') {
    const analysis = buildPositionTradeDeskAnalysis(
      presentation,
      selectedContract,
      position,
      underlyingLast,
    );
    return (
      <PositionTradeDeskGrid
        analysis={analysis}
        viewState={viewState}
        onApply={onApply}
        onRefresh={onRefresh}
        onDismiss={onDismiss}
        applyError={applyError}
      />
    );
  }

  const analysis = buildFlatTradeDeskAnalysis(presentation, selectedContract);
  return (
    <FlatTradeDeskGrid
      analysis={analysis}
      viewState={viewState}
      onApply={onApply}
      onRefresh={onRefresh}
      onDismiss={onDismiss}
      applyError={applyError}
    />
  );
}

function TradeDeskGridFooter({
  viewState,
  onApply,
  onRefresh,
  onDismiss,
  applyError,
}: {
  viewState: TradeDeskViewState;
  onApply: () => void;
  onRefresh: () => void;
  onDismiss: () => void;
  applyError: string | null;
}) {
  const presentation = viewState.presentation;
  if (!presentation) return null;
  return (
    <div className="trade-desk__actions">
      <button
        type="button"
        className="trade-desk__apply"
        onClick={onApply}
        disabled={!viewState.canApplySuggestedPrice || viewState.status !== 'current'}
        aria-label={
          presentation.applicablePriceSuggestion
            ? `Apply suggested contract price of ${presentation.entry?.preferredContractPrice?.value}`
            : 'Apply suggested contract price'
        }
      >
        {presentation.applicablePriceSuggestion
          ? `USE ${presentation.entry?.preferredContractPrice?.value} ENTRY`
          : 'NO ENTRY PRICE'}
      </button>
      <button type="button" onClick={onDismiss} aria-label="Dismiss this Trade Desk assessment">
        Dismiss
      </button>
      <button
        type="button"
        onClick={onRefresh}
        disabled={viewState.status === 'generating'}
        aria-label="Refresh Trade Desk assessment"
      >
        Refresh
      </button>
      {applyError ? (
        <span className="trade-desk__local-error" role="alert">
          {applyError}
        </span>
      ) : null}
    </div>
  );
}

function FlatTradeDeskGrid({
  analysis,
  viewState,
  onApply,
  onRefresh,
  onDismiss,
  applyError,
}: {
  analysis: FlatTradeDeskAnalysis;
  viewState: TradeDeskViewState;
  onApply: () => void;
  onRefresh: () => void;
  onDismiss: () => void;
  applyError: string | null;
}) {
  return (
    <div className="trade-desk__body">
      <div className="trade-desk__grid">
        <TradeDeskCell cell={analysis.setup} />
        <TradeDeskCell cell={analysis.entry} />
        <TradeDeskCell cell={analysis.invalidation} />
        <TradeDeskCell cell={analysis.targets} />
        <TradeDeskCell cell={analysis.contract} />
        <TradeDeskCell cell={analysis.premiumLimit} />
        <TradeDeskCell cell={analysis.execution} />
        <TradeDeskCell cell={analysis.runner} />
      </div>
      <TradeDeskGridFooter
        viewState={viewState}
        onApply={onApply}
        onRefresh={onRefresh}
        onDismiss={onDismiss}
        applyError={applyError}
      />
    </div>
  );
}

function PositionTradeDeskGrid({
  analysis,
  viewState,
  onApply,
  onRefresh,
  onDismiss,
  applyError,
}: {
  analysis: PositionTradeDeskAnalysis;
  viewState: TradeDeskViewState;
  onApply: () => void;
  onRefresh: () => void;
  onDismiss: () => void;
  applyError: string | null;
}) {
  return (
    <div className="trade-desk__body">
      <div className="trade-desk__grid">
        <TradeDeskCell cell={analysis.position} />
        <TradeDeskCell cell={analysis.currentAction} />
        <TradeDeskCell cell={analysis.invalidation} />
        <TradeDeskCell cell={analysis.targets} />
        <TradeDeskCell cell={analysis.scale} />
        <TradeDeskCell cell={analysis.optionStop} />
        <TradeDeskCell cell={analysis.underlying} />
        <TradeDeskCell cell={analysis.runner} />
      </div>
      <TradeDeskGridFooter
        viewState={viewState}
        onApply={onApply}
        onRefresh={onRefresh}
        onDismiss={onDismiss}
        applyError={applyError}
      />
    </div>
  );
}

function TradeDeskCell({ cell }: { cell: TradeDeskGridCell }) {
  return (
    <div className="trade-desk__cell">
      <span className="trade-desk__cell-label">{cell.label}</span>
      <strong className="trade-desk__cell-value numeric">{cell.value}</strong>
      {cell.secondary ? <span className="trade-desk__cell-secondary">{cell.secondary}</span> : null}
    </div>
  );
}

function useRelativeAge(generatedAt?: string): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!generatedAt) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [generatedAt]);
  if (!generatedAt) return null;
  const seconds = Math.max(0, Math.floor((now - Date.parse(generatedAt)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

function TradeDeskActionBadge({ presentation }: { presentation: TradeDeskPresentation }) {
  return (
    <span className={`trade-desk__action trade-desk__action--${presentation.action}`}>
      {presentation.actionLabel}
    </span>
  );
}

function statusLabel(
  status: TradeDeskViewState['status'],
  marketSessionState: TradeDeskViewState['marketSessionState'],
): string {
  // A "current" result (identity matches, per the staleness gate) can still
  // be non-actionable if the market itself is closed, stale, or
  // unavailable — that must never render as LIVE.
  if (status === 'current') {
    switch (marketSessionState) {
      case 'live':
        return 'LIVE';
      case 'delayed':
        return 'DELAYED';
      case 'market-closed':
        return 'MARKET CLOSED';
      case 'stale':
        return 'STALE';
      case 'unavailable':
        return 'UNAVAILABLE';
    }
  }
  switch (status) {
    case 'generating':
      return 'ANALYZING';
    case 'stale':
      return 'STALE';
    case 'failed':
      return 'FAILED';
    case 'disabled':
      return 'DISABLED';
    default:
      return 'UNAVAILABLE';
  }
}

function placeholderDetail(viewState: TradeDeskViewState): string | null {
  if (viewState.status === 'failed') return 'Check connection and retry.';
  if (!viewState.staleReason) return null;
  return clampText(viewState.staleReason, 80);
}

function emptyStatusText(viewState: TradeDeskViewState): string {
  if (viewState.status === 'generating') return 'Analyzing current setup…';
  if (viewState.status === 'failed') return 'Analysis unavailable.';
  if (viewState.status === 'disabled') return 'Trade Desk disabled.';
  return 'Trade Desk assessment unavailable.';
}
