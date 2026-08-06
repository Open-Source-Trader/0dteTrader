// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../../core/api/ApiClient';
import { ChainStore } from './ChainStore';
import { TradePanel } from './TradePanel';
import { TradeStore } from './TradeStore';

describe('TradePanel Scored Auto fallback', () => {
  it('does not render stale rationale while a replacement ranking loads', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false }),
    });
    const apiClient = {} as ApiClient;
    const chainStore = new ChainStore(apiClient);
    const tradeStore = new TradeStore(apiClient);
    const current = chainStore.getState();
    (chainStore as unknown as { state: typeof current }).state = {
      ...current,
      underlying: 'SPY',
      isAutoMode: true,
      isAutoScoringLoading: true,
      autoSelectionStrategy: 'scored',
      autoScoringResult: {
        rankings: [
          {
            rank: 1,
            candidate: {
              symbol: 'SPY260805C00501000',
              underlying: 'SPY',
              strike: 501,
              expiration: '2026-08-05',
              optionType: 'call',
              bid: 1,
              ask: 1.1,
              delta: 0.25,
              gamma: 0.02,
              impliedVolatility: 0.2,
              openInterest: 1_000,
              quoteProvider: 'webull',
              quoteTimestamp: '2026-08-05T15:00:00.000Z',
              analyticsTimestamp: '2026-08-05T15:00:00.000Z',
            },
            score: 0.9,
            rationale: {
              summary: 'STALE CALL RATIONALE',
              mid: 1.05,
              spreadBps: 952,
              premiumDollars: 105,
              atmDistance: 1,
              normalized: { delta: 1, spread: 1, openInterest: 1, gamma: 1, iv: 1 },
              weighted: { delta: 0.3, spread: 0.25, openInterest: 0.2, gamma: 0.1, iv: 0.15 },
            },
          },
        ],
        exclusions: [],
        selectedSymbol: 'SPY260805C00501000',
        noPass: false,
        requiresConfirmation: true,
        rankedAt: '2026-08-05T15:00:00.000Z',
      },
    };

    const markup = renderToStaticMarkup(
      createElement(TradePanel, { tradeStore, chainStore, onArm: () => undefined }),
    );

    expect(markup).toContain('Ranking fresh contracts');
    expect(markup).not.toContain('STALE CALL RATIONALE');
  });

  it('offers an explicit Classic fallback acknowledgment when no candidate passes', () => {
    const apiClient = {} as ApiClient;
    const chainStore = new ChainStore(apiClient);
    const tradeStore = new TradeStore(apiClient);
    const current = chainStore.getState();
    (chainStore as unknown as { state: typeof current }).state = {
      ...current,
      underlying: 'SPY',
      isAutoMode: true,
      autoSelectionStrategy: 'scored',
      autoScoringResult: {
        rankings: [],
        exclusions: [],
        selectedSymbol: null,
        noPass: true,
        requiresConfirmation: true,
        rankedAt: '2026-08-05T15:00:00.000Z',
      },
    };

    const markup = renderToStaticMarkup(
      createElement(TradePanel, {
        tradeStore,
        chainStore,
        onArm: () => undefined,
      }),
    );

    expect(markup).toContain('No pass · Acknowledge Classic +1 fallback');
    expect(markup).toContain('aria-pressed="false"');
  });
});
