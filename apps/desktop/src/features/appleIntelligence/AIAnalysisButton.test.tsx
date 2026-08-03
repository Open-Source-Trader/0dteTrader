import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../../core/api/ApiClient';
import { TradeStore } from '../trade/TradeStore';
import { AIAnalysisButton } from './AIAnalysisButton';
import { AnalysisStore } from './AnalysisStore';
import type { AppleIntelligenceBridge } from '../../core/desktop/appleIntelligence';
import type { AnalysisSnapshot } from './types';

function makeTradeStore(): TradeStore {
  return new TradeStore({} as ApiClient);
}

function makeSnapshot(): AnalysisSnapshot {
  return {
    snapshotSchemaVersion: 1,
    identity: {
      snapshotId: 's1',
      capturedAt: '2026-07-31T00:00:00.000Z',
      symbol: 'SPY',
      timeframe: '5m',
      snapshotSequence: 1,
      positionVersion: 0,
    },
    trigger: { kind: 'manual', priority: 'manual', reason: 'user requested' },
    market: {},
    candles: {},
    indicators: {},
    levels: [],
    quality: {
      capturedAt: '2026-07-31T00:00:00.000Z',
      candlesFreshAsOf: '2026-07-31T00:00:00.000Z',
      isChainStale: false,
    },
    omissions: [],
  };
}

function noopBridge(): AppleIntelligenceBridge {
  return {
    getAvailability: async () => ({ state: 'unavailable' }),
    analyze: async () => ({ requestId: 'r1' }),
    cancel: async () => undefined,
    subscribe: () => () => {},
  };
}

describe('AIAnalysisButton', () => {
  it('renders without a bridge (feature absent) without throwing', () => {
    const store = new AnalysisStore(null);
    const markup = renderToStaticMarkup(
      createElement(AIAnalysisButton, {
        analysisStore: store,
        tradeStore: makeTradeStore(),
        selectedContract: null,
        buildSnapshot: makeSnapshot,
      }),
    );
    expect(markup).toContain('AI');
  });

  it('renders with a bridge present without throwing', () => {
    const store = new AnalysisStore(noopBridge());
    const markup = renderToStaticMarkup(
      createElement(AIAnalysisButton, {
        analysisStore: store,
        tradeStore: makeTradeStore(),
        selectedContract: null,
        buildSnapshot: makeSnapshot,
      }),
    );
    expect(markup).toContain('AI');
  });
});
