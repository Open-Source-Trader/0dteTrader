import { useEffect, useMemo, useState } from 'react';
import type { OptionContract } from '@0dtetrader/shared-types';
import { useStore, shallowEqual } from '../../core/observable';
import type { AnalysisSnapshot } from '../appleIntelligence/types';
import type { AnalysisStore } from '../appleIntelligence/AnalysisStore';
import { hashPositionVersion } from '../appleIntelligence/AnalysisSnapshotBuilder';
import {
  buildTradeDeskViewState,
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
}

export function TradeDeskPanel({
  analysisStore,
  tradeStore,
  chainStore,
  selectedContract,
  buildSnapshot,
  locked = false,
}: TradeDeskPanelProps) {
  const analysis = useStore(
    analysisStore,
    (state) => ({
      availability: state.availability,
      isAnalyzing: state.isAnalyzing,
      latestResult: state.latestResult,
      errorMessage: state.errorMessage,
    }),
    shallowEqual,
  );
  const trade = useStore(
    tradeStore,
    (state) => ({ positions: state.positions, isSubmitting: state.isSubmitting }),
    shallowEqual,
  );
  const [expanded, setExpanded] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem('tradeDesk.expanded') === '1',
  );
  const [dismissedResultId, setDismissedResultId] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('tradeDesk.expanded', expanded ? '1' : '0');
    }
  }, [expanded]);

  const currentPositionVersion = useMemo(() => {
    if (!selectedContract) return 0;
    const position = trade.positions.find(
      (candidate) => candidate.symbol === selectedContract.symbol,
    );
    return position ? hashPositionVersion(position) : 0;
  }, [selectedContract, trade.positions]);

  const currentContext = useMemo(() => {
    const latest = analysis.latestResult?.context;
    if (!latest) return null;
    return {
      ...latest,
      selectedContractSymbol: selectedContract?.symbol,
      positionVersion: currentPositionVersion,
    };
  }, [analysis.latestResult, selectedContract, currentPositionVersion]);

  const viewState = useMemo(
    () =>
      buildTradeDeskViewState({
        ...analysis,
        currentContext,
        selectedContract,
        currentPositionVersion,
        dismissedResultId,
        disabled: locked,
      }),
    [analysis, currentContext, selectedContract, currentPositionVersion, dismissedResultId, locked],
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
    if (viewState.presentation?.snapshotId !== suggestion.snapshotId) {
      setApplyError('Assessment changed. Refresh Trade Desk.');
      return;
    }
    const result = tradeStore.applyTradeDeskPrice(
      { type: 'apply-trade-desk-price', suggestion },
      chainStore,
    );
    if (!result.ok) setApplyError(result.error);
  };

  const presentation = viewState.presentation;
  return (
    <section className={`trade-desk trade-desk--${viewState.status}`} aria-label="AI Trade Desk">
      <button
        type="button"
        className="trade-desk__header"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse AI Trade Desk' : 'Expand AI Trade Desk'}
      >
        <span className="trade-desk__eyebrow">AI TRADE DESK</span>
        {presentation ? <TradeDeskActionBadge presentation={presentation} /> : null}
        <span className="trade-desk__header-spacer" />
        {presentation?.entry?.preferredContractPrice ? (
          <span className="trade-desk__entry-chip numeric">
            Entry {presentation.entry.preferredContractPrice.value}
          </span>
        ) : null}
        <TradeDeskStatus viewState={viewState} />
        <span className="trade-desk__chevron" aria-hidden="true">
          {expanded ? '˄' : '˅'}
        </span>
      </button>

      {!expanded ? <TradeDeskCollapsedView viewState={viewState} onRefresh={refresh} /> : null}
      {expanded ? (
        <TradeDeskExpandedView
          viewState={viewState}
          onApply={applySuggestedPrice}
          onDismiss={() => presentation && setDismissedResultId(presentation.resultId)}
          onRefresh={refresh}
          applyError={applyError}
        />
      ) : null}
    </section>
  );
}

function TradeDeskCollapsedView({
  viewState,
  onRefresh,
}: {
  viewState: TradeDeskViewState;
  onRefresh: () => void;
}) {
  if (!viewState.presentation) {
    return (
      <div className="trade-desk__collapsed-empty">
        <span>{emptyStatusText(viewState)}</span>
        {viewState.status === 'failed' || viewState.status === 'unavailable' ? (
          <button type="button" onClick={onRefresh}>
            Refresh
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="trade-desk__collapsed-line">
      <span>{viewState.presentation.setupLabel}</span>
      <span className="trade-desk__muted"> · {viewState.presentation.summary}</span>
    </div>
  );
}

function TradeDeskExpandedView({
  viewState,
  onApply,
  onDismiss,
  onRefresh,
  applyError,
}: {
  viewState: TradeDeskViewState;
  onApply: () => void;
  onDismiss: () => void;
  onRefresh: () => void;
  applyError: string | null;
}) {
  const presentation = viewState.presentation;
  if (!presentation) {
    return (
      <div className="trade-desk__empty" role="status">
        <div>{emptyStatusText(viewState)}</div>
        {viewState.staleReason ? <small>{viewState.staleReason}</small> : null}
        <button type="button" onClick={onRefresh} disabled={viewState.status === 'generating'}>
          Refresh Trade Desk
        </button>
      </div>
    );
  }

  return (
    <div className="trade-desk__expanded">
      <div className="trade-desk__body-scroll">
        <div className="trade-desk__headline">
          <strong>{presentation.setupLabel}</strong>
          <p>{presentation.summary}</p>
        </div>

        <div className="trade-desk__grid">
          <TradeDeskPriceBlock title="ENTRY" items={priceItems(presentation.entry)} />
          <TradeDeskPriceBlock
            title="INVALIDATION"
            items={conditionItems(presentation.invalidation)}
          />
          <TradeDeskTargets presentation={presentation} />
          <TradeDeskManagement presentation={presentation} />
        </div>

        <div className="trade-desk__meta-row">
          {presentation.confidence ? (
            <span>Confidence: {presentation.confidence.toUpperCase()}</span>
          ) : null}
          {presentation.warnings.map((warning) => (
            <span key={warning} className="trade-desk__warning">
              {warning}
            </span>
          ))}
        </div>
        {viewState.status === 'stale' && viewState.staleReason ? (
          <div className="trade-desk__local-error" role="status">
            {viewState.staleReason}
          </div>
        ) : null}
        {applyError ? (
          <div className="trade-desk__local-error" role="alert">
            {applyError}
          </div>
        ) : null}
      </div>
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
      </div>
    </div>
  );
}

function TradeDeskStatus({ viewState }: { viewState: TradeDeskViewState }) {
  const age = useRelativeAge(viewState.generatedAt);
  const label = statusLabel(viewState.status);
  return (
    <span className="trade-desk__status" role="status" aria-live="polite">
      {viewState.status === 'current' && age ? `${label} · ${age}` : label}
    </span>
  );
}

function TradeDeskActionBadge({ presentation }: { presentation: TradeDeskPresentation }) {
  return (
    <span className={`trade-desk__action trade-desk__action--${presentation.action}`}>
      {presentation.actionLabel}
    </span>
  );
}

function TradeDeskPriceBlock({
  title,
  items,
}: {
  title: string;
  items: Array<{ label: string; value: string }>;
}) {
  return (
    <div className="trade-desk__block">
      <h4>{title}</h4>
      {items.length > 0 ? (
        items.map((item) => (
          <div key={`${item.label}:${item.value}`} className="trade-desk__level">
            <span>{item.label}</span>
            <strong className="numeric">{item.value}</strong>
          </div>
        ))
      ) : (
        <div className="trade-desk__empty-line">—</div>
      )}
    </div>
  );
}

function TradeDeskTargets({ presentation }: { presentation: TradeDeskPresentation }) {
  const items = [
    ...presentation.contractTargets.map((target) => ({ ...target, domain: 'Contract' })),
    ...presentation.underlyingTargets.map((target) => ({ ...target, domain: 'Underlying' })),
  ];
  return (
    <div className="trade-desk__block">
      <h4>TARGETS</h4>
      {items.length > 0 ? (
        items.map((target) => (
          <div
            key={`${target.domain}:${target.role}:${target.value}`}
            className="trade-desk__level"
          >
            <span>
              {target.domain} {target.label}
            </span>
            <strong className="numeric">{target.value}</strong>
          </div>
        ))
      ) : (
        <div className="trade-desk__empty-line">—</div>
      )}
    </div>
  );
}

function TradeDeskManagement({ presentation }: { presentation: TradeDeskPresentation }) {
  const items = [
    ...presentation.management.holdConditions.map((value) => ({ label: 'Hold', value })),
    ...presentation.management.scaleConditions.map((value) => ({ label: 'Scale', value })),
    ...presentation.management.exitConditions.map((value) => ({ label: 'Exit', value })),
  ];
  return (
    <div className="trade-desk__block">
      <h4>MANAGEMENT</h4>
      {items.length > 0 ? (
        items.map((item) => (
          <div key={`${item.label}:${item.value}`} className="trade-desk__management-line">
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </div>
        ))
      ) : (
        <div className="trade-desk__empty-line">—</div>
      )}
    </div>
  );
}

function priceItems(
  entry: TradeDeskPresentation['entry'],
): Array<{ label: string; value: string }> {
  if (!entry) return [];
  return [entry.underlying, entry.contract, entry.preferredContractPrice]
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .map((item) => ({ label: item.label, value: item.value }));
}

function conditionItems(
  invalidation: TradeDeskPresentation['invalidation'],
): Array<{ label: string; value: string }> {
  if (!invalidation) return [];
  return [invalidation.underlying, invalidation.contract]
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .map((item) => ({ label: item.label, value: item.value }));
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

function statusLabel(status: TradeDeskViewState['status']): string {
  switch (status) {
    case 'current':
      return 'LIVE';
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

function emptyStatusText(viewState: TradeDeskViewState): string {
  if (viewState.status === 'generating') return 'Analyzing current setup…';
  if (viewState.status === 'failed') return 'Trade Desk assessment failed.';
  if (viewState.status === 'disabled') return 'Trade Desk disabled.';
  return 'Trade Desk assessment unavailable.';
}
