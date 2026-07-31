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
  DrawToolsMenu: () => createElement('div', { 'data-testid': 'draw-tools-menu' }),
  DrawToolsRail: () => createElement('div', { 'data-testid': 'draw-tools-rail' }),
}));

vi.mock('./chartColors', () => ({
  overlayPalette: () => ({}),
  panePalette: () => ({}),
}));

vi.mock('./optionsAnalytics/useOptionsAnalytics', () => ({
  useOptionsAnalytics: (
    _apiClient: ApiClient,
    _symbol: string,
    _expiration: string | null,
    settings: { enabled: boolean },
  ) => ({
    snapshot: null,
    isLoading: false,
    retained: false,
    errorMessage: settings.enabled ? 'shadow capture failed' : null,
  }),
}));

async function loadChartView() {
  return import('./ChartView').catch(() => null);
}

function makeStore(overrides: Partial<ReturnType<typeof baseState>> = {}) {
  const state = { ...baseState(), ...overrides };
  return {
    getState: () => state,
    subscribe: () => () => undefined,
    selectInterval: vi.fn(),
    loadCandles: vi.fn(),
  } as unknown as ChartStore;
}

function baseState() {
  return {
    symbol: 'SPY',
    interval: '1m' as const,
    candles: [],
    quote: {
      symbol: 'SPY',
      bid: 728.4,
      ask: 728.84,
      last: 728,
      timestamp: new Date().toISOString(),
    },
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
}

async function renderChart(
  overrides: Partial<ReturnType<typeof baseState>> = {},
  props: { dense?: boolean; onIndicatorSettings?: () => void } = {},
) {
  const module = await loadChartView();
  expect(module).not.toBeNull();
  if (!module) return '';
  return renderToStaticMarkup(
    createElement(module.ChartView, {
      store: makeStore(overrides),
      drawingsStore: {} as DrawingsStore,
      apiClient: {} as ApiClient,
      onSymbolSearch: vi.fn(),
      onIndicatorSettings: props.onIndicatorSettings ?? vi.fn(),
      onShowProfile: vi.fn(),
      onShowHistory: vi.fn(),
      tradingMode: 'practice',
      onToggleMode: vi.fn(),
      onToggleFullscreen: vi.fn(),
      chartTrading: null,
      optionsAnalyticsExpiration: '2026-07-19',
      dense: props.dense,
    }),
  );
}

describe('ChartView options analytics rendering', () => {
  it('hides shadow-capture errors while the overlay is disabled', async () => {
    const markup = await renderChart({
      optionsAnalytics: { ...DEFAULT_OPTIONS_ANALYTICS_SETTINGS, enabled: false },
    });

    expect(markup).not.toContain('Options analytics unavailable');
    expect(markup).not.toContain('shadow capture failed');
  });
});

describe('ChartView chart shell structure', () => {
  it('renders toolbar, warning row, drawing rail, and plot inside one chart shell', async () => {
    const markup = await renderChart(
      { optionsAnalytics: { ...DEFAULT_OPTIONS_ANALYTICS_SETTINGS, enabled: true } },
      { dense: true },
    );

    expect(markup).toContain('class="chart-shell chart-shell--desktop"');
    expect(markup.indexOf('data-chart-toolbar="true"')).toBeGreaterThan(
      markup.indexOf('chart-shell'),
    );
    expect(markup.indexOf('chart-warning-row')).toBeGreaterThan(
      markup.indexOf('data-chart-toolbar="true"'),
    );
    expect(markup.indexOf('data-chart-plot-area="true"')).toBeGreaterThan(
      markup.indexOf('chart-warning-row'),
    );
    expect(markup.indexOf('data-testid="draw-tools-rail"')).toBeGreaterThan(
      markup.indexOf('chart-warning-row'),
    );
    expect(markup.indexOf('data-testid="candle-chart"')).toBeGreaterThan(
      markup.indexOf('data-testid="draw-tools-rail"'),
    );
  });

  it('removing the warning keeps the toolbar and plot siblings without overlay text', async () => {
    const markup = await renderChart(
      { optionsAnalytics: { ...DEFAULT_OPTIONS_ANALYTICS_SETTINGS, enabled: false } },
      { dense: true },
    );

    expect(markup).toContain('data-chart-toolbar="true"');
    expect(markup).toContain('data-chart-plot-area="true"');
    expect(markup).not.toContain('chart-warning-row');
  });

  it('keeps indicators as the established settings trigger, not a no-op fragment', async () => {
    const onIndicatorSettings = vi.fn();
    const markup = await renderChart({}, { dense: true, onIndicatorSettings });

    expect(markup).toContain('chart-command-bar__indicators');
    expect(markup).toContain('aria-label="Indicators"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('title="Indicators"');
    expect(markup).not.toContain('chart-command-bar__settings-label');
  });
});
