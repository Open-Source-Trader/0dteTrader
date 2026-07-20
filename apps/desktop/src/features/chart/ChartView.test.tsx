import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../core/api/ApiClient';
import { DEFAULT_INDICATOR_SETTINGS } from './indicatorSettings';
import { DEFAULT_OPTIONS_ANALYTICS_SETTINGS } from './optionsAnalytics/optionsAnalyticsSettings';
import { DEFAULT_TWC_SETTINGS } from './twc/twcSettings';
import type { ChartStore } from './ChartStore';
import type { DrawingsStore } from './drawings';

vi.mock('./CandleChart', () => ({
  CandleChart: () => createElement('div', { 'data-testid': 'candle-chart' }),
}));

vi.mock('./DrawingToolbar', () => ({
  DrawToolsMenu: () => null,
}));

vi.mock('./chartColors', () => ({
  overlayPalette: () => ({}),
  panePalette: () => ({}),
}));

vi.mock('./optionsAnalytics/useOptionsAnalytics', () => ({
  useOptionsAnalytics: () => ({
    snapshot: null,
    isLoading: false,
    retained: false,
    errorMessage: 'shadow capture failed',
  }),
}));

async function loadChartView() {
  return import('./ChartView').catch(() => null);
}

describe('ChartView options analytics rendering', () => {
  it('hides shadow-capture errors while the overlay is disabled', async () => {
    const module = await loadChartView();
    expect(module).not.toBeNull();
    if (!module) return;
    const state = {
      symbol: 'SPY',
      interval: '1m' as const,
      candles: [],
      quote: null,
      isLoading: false,
      errorMessage: null,
      isStale: false,
      indicatorSettings: {
        ...DEFAULT_INDICATOR_SETTINGS,
        emaEnabled: false,
        vwapEnabled: false,
        volumeEnabled: false,
      },
      twcSettings: { ...DEFAULT_TWC_SETTINGS, enabled: false },
      optionsAnalytics: { ...DEFAULT_OPTIONS_ANALYTICS_SETTINGS, enabled: false },
    };
    const store = {
      getState: () => state,
      subscribe: () => () => undefined,
      selectInterval: vi.fn(),
    } as unknown as ChartStore;

    const markup = renderToStaticMarkup(
      createElement(module.ChartView, {
        store,
        drawingsStore: {} as DrawingsStore,
        apiClient: {} as ApiClient,
        onSymbolSearch: vi.fn(),
        onIndicatorSettings: vi.fn(),
        tradingMode: 'practice',
        onToggleMode: vi.fn(),
        optionsAnalyticsExpiration: '2026-07-19',
      }),
    );

    expect(markup).not.toContain('Options analytics unavailable');
    expect(markup).not.toContain('shadow capture failed');
  });
});
