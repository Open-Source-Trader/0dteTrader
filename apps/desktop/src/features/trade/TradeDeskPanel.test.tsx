import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../core/api/ApiClient';
import { AnalysisStore } from '../appleIntelligence/AnalysisStore';
import type { AnalysisSnapshot, AnalysisResult } from '../appleIntelligence/types';
import { ChainStore } from './ChainStore';
import { TradeStore } from './TradeStore';
import { TradeDeskPanel } from './TradeDeskPanel';

const contract = {
  symbol: 'SPY260731C00746000',
  underlying: 'SPY',
  expiration: '2026-07-31',
  strike: 746,
  optionType: 'call' as const,
  bid: 1.8,
  ask: 1.9,
  last: 1.85,
};

function makeResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    resultSchemaVersion: 1,
    analysisId: 'r1',
    context: {
      snapshotId: 'snap-1',
      symbol: 'SPY',
      timeframe: '1m',
      snapshotSequence: 1,
      positionVersion: 0,
      selectedContractSymbol: contract.symbol,
    },
    generatedAt: new Date().toISOString(),
    recommendation: 'wait',
    setupState: 'forming',
    bias: 'bullish',
    levels: {},
    confidence: 0.8,
    reasons: [],
    warnings: [],
    assumptions: [],
    observedOmissions: [],
    summary: 'Momentum intact; wait for pullback.',
    tradeDeskPlan: {
      action: 'wait',
      setupLabel: 'Bullish pullback',
      summary: 'Momentum intact; wait for pullback.',
      entry: {
        underlying: {
          low: 746.55,
          high: 746.65,
          priceDomain: 'underlying',
          evidenceId: 'e1',
          snapshotId: 'snap-1',
        },
        contract: {
          low: 1.82,
          high: 1.88,
          priceDomain: 'contract-premium',
          evidenceId: 'e2',
          snapshotId: 'snap-1',
        },
        preferredContractPrice: {
          value: 1.85,
          priceDomain: 'contract-premium',
          evidenceId: 'e3',
          snapshotId: 'snap-1',
        },
      },
      targets: {
        contract: [
          {
            role: 'first',
            price: {
              value: 2.15,
              priceDomain: 'contract-premium',
              evidenceId: 't1',
              snapshotId: 'snap-1',
            },
          },
        ],
      },
      management: {
        holdConditions: ['Hold above VWAP'],
        scaleConditions: [],
        exitConditions: ['Cut on failed reclaim'],
      },
      confidence: 'high',
    },
    ...overrides,
  };
}

function makeStores(result: AnalysisResult | null = makeResult()) {
  const apiClient = {} as ApiClient;
  const analysisStore = new AnalysisStore(null);
  (analysisStore as unknown as { state: unknown }).state = {
    availability: { state: 'ready' },
    isAnalyzing: false,
    activeRequestId: null,
    activePriority: null,
    latestResult: result,
    latestTriggerKind: 'manual',
    errorMessage: null,
    history: [],
    queueDepth: 0,
    lastAnalysisDurationMs: null,
  };
  const chainStore = new ChainStore(apiClient);
  (chainStore as unknown as { state: unknown }).state = {
    underlying: 'SPY',
    chain: {
      underlying: 'SPY',
      underlyingPrice: 746.7,
      expirations: ['2026-07-31'],
      contracts: [contract],
    },
    isLoading: false,
    errorMessage: null,
    optionType: 'call',
    isAutoMode: false,
    selectedExpiration: '2026-07-31',
    selectedStrike: 746,
    underlyingLast: 746.7,
  };
  const tradeStore = new TradeStore(apiClient);
  const snapshot = { identity: { snapshotId: 'snap-1' } } as AnalysisSnapshot;
  return { analysisStore, chainStore, tradeStore, snapshot };
}

function markup({
  result = makeResult(),
  isQuoteStreamStale = false,
  hasPosition = false,
}: {
  result?: AnalysisResult | null;
  isQuoteStreamStale?: boolean;
  hasPosition?: boolean;
} = {}) {
  const stores = makeStores(result);
  if (hasPosition) {
    (stores.tradeStore as unknown as { state: unknown }).state = {
      ...stores.tradeStore.getState(),
      positions: [
        {
          symbol: contract.symbol,
          assetClass: 'option',
          quantity: 1,
          avgPrice: 1.8,
          markPrice: 1.9,
          unrealizedPnl: 10,
          multiplier: 100,
        },
      ],
    };
  }
  return renderToStaticMarkup(
    createElement(TradeDeskPanel, {
      analysisStore: stores.analysisStore,
      chainStore: stores.chainStore,
      tradeStore: stores.tradeStore,
      selectedContract: contract,
      buildSnapshot: () => stores.snapshot,
      isQuoteStreamStale,
    }),
  );
}

describe('TradeDeskPanel', () => {
  it('renders the flat 8-cell grid with action, setup, and entry', () => {
    const html = markup();
    expect(html).toContain('AI TRADE DESK');
    expect(html).toContain('WAIT');
    expect(html).toContain('FLAT');
    expect(html).toContain('SETUP');
    expect(html).toContain('Bullish pullback');
    expect(html).toContain('ENTRY');
    expect(html).toContain('SPY 746.55–746.65');
    expect(html).toContain('TARGETS');
    expect(html).toContain('T1 $2.15');
    expect(html).toContain('CONTRACT');
    expect(html).toContain('SPY 746C');
    expect(html).toContain('PREMIUM LIMIT');
    expect(html).toContain('EXECUTION');
    expect(html).toContain('RUNNER');
    expect(html).toContain('USE $1.85 ENTRY');
    expect(html).not.toContain('IN TRADE');
  });

  it('renders the in-trade 8-cell grid when an open position exists, not the flat plan', () => {
    const html = markup({ hasPosition: true });
    expect(html).toContain('IN TRADE');
    expect(html).not.toContain('>FLAT<');
    expect(html).toContain('POSITION');
    expect(html).toContain('SPY 746C');
    expect(html).toContain('CURRENT ACTION');
    expect(html).toContain('SCALE');
    expect(html).toContain('OPTION STOP');
    expect(html).toContain('UNDERLYING');
    expect(html).toContain('RUNNER');
    // Flat-only fields must not dominate the in-trade board.
    expect(html).not.toContain('PREMIUM LIMIT');
  });

  it('marks stale guidance and disables apply when selected contract changed', () => {
    const stale = makeResult({
      context: { ...makeResult().context, selectedContractSymbol: 'OTHER' },
    });
    const html = markup({ result: stale });
    expect(html).toContain('STALE');
    expect(html).toContain('disabled=""');
  });

  it('shows LIVE during regular trading hours with a fresh quote stream', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T15:00:00.000Z')); // Wed 11:00 ET
    const html = markup({ isQuoteStreamStale: false });
    vi.useRealTimers();
    expect(html).toContain('LIVE');
  });

  it('shows MARKET CLOSED outside trading hours, never LIVE', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T15:00:00.000Z')); // Saturday
    const html = markup({ isQuoteStreamStale: false });
    vi.useRealTimers();
    expect(html).toContain('MARKET CLOSED');
    expect(html).not.toContain('>LIVE<');
  });

  it('shows UNAVAILABLE when the quote stream is stale, even during trading hours', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T15:00:00.000Z')); // Wed 11:00 ET
    const html = markup({ isQuoteStreamStale: true });
    vi.useRealTimers();
    expect(html).toContain('UNAVAILABLE');
  });

  it('preserves the last valid grid while a new analysis is generating', () => {
    const stores = makeStores(makeResult());
    (stores.analysisStore as unknown as { state: unknown }).state = {
      ...stores.analysisStore.getState(),
      isAnalyzing: true,
    };
    const html = renderToStaticMarkup(
      createElement(TradeDeskPanel, {
        analysisStore: stores.analysisStore,
        chainStore: stores.chainStore,
        tradeStore: stores.tradeStore,
        selectedContract: contract,
        buildSnapshot: () => stores.snapshot,
      }),
    );
    expect(html).toContain('Bullish pullback');
    expect(html).toContain('trade-desk__analyzing-dot');
  });

  it('shows a bounded placeholder, not a raw error, when analysis fails with no prior result', () => {
    const stores = makeStores(null);
    (stores.analysisStore as unknown as { state: unknown }).state = {
      ...stores.analysisStore.getState(),
      latestResult: null,
      errorMessage: 'Options snapshot is missing required delta values at line 42 in module x.y.z',
    };
    const html = renderToStaticMarkup(
      createElement(TradeDeskPanel, {
        analysisStore: stores.analysisStore,
        chainStore: stores.chainStore,
        tradeStore: stores.tradeStore,
        selectedContract: contract,
        buildSnapshot: () => stores.snapshot,
      }),
    );
    expect(html).toContain('FAILED');
    expect(html).toContain('Retry');
    expect(html).not.toContain('line 42');
  });
});
