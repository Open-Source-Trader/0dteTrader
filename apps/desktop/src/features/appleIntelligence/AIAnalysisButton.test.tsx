// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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
  afterEach(cleanup);

  it('does not re-render on a store field it does not read (focused selector)', () => {
    const store = new AnalysisStore(noopBridge());
    let renderCount = 0;
    // renderCount must be bumped from inside AIAnalysisButton's own render,
    // not a wrapping component — a wrapper's render count wouldn't move
    // just because only the child re-renders.
    function CountingButton(props: Parameters<typeof AIAnalysisButton>[0]) {
      renderCount += 1;
      return AIAnalysisButton(props);
    }
    render(
      createElement(CountingButton, {
        analysisStore: store,
        tradeStore: makeTradeStore(),
        selectedContract: null,
        buildSnapshot: makeSnapshot,
      }),
    );
    const afterMount = renderCount;

    // queueDepth is set() on the store but never read by AIAnalysisButton —
    // a full-state (selector-less) useStore would re-render on every set(),
    // including this one.
    act(() => {
      (store as unknown as { set: (patch: Record<string, unknown>) => void }).set({
        queueDepth: 1,
      });
    });
    expect(renderCount).toBe(afterMount);

    // A field it DOES read must still trigger a re-render.
    act(() => {
      (store as unknown as { set: (patch: Record<string, unknown>) => void }).set({
        isAnalyzing: true,
      });
    });
    expect(renderCount).toBe(afterMount + 1);
  });

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
