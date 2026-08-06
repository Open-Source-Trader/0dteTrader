import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { IndicatorSettingsState } from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { DEFAULT_CHART_DISPLAY, DEFAULT_INDICATOR_SETTINGS_STATE } from './indicatorRegistry';
import { DEFAULT_OPTIONS_ANALYTICS_SETTINGS } from './optionsAnalytics/optionsAnalyticsSettings';
import { DEFAULT_TWC_SETTINGS } from './twc/twcSettings';
import { DEFAULT_USR_SETTINGS } from './ultimateSupportResistance/usrSettings';
import type { ChartCandle, ChartStore, ChartStoreState } from './ChartStore';
import type { VisibleCandleViewport } from './candleViewport';
import type { DrawingsStore } from './drawings';

vi.mock('./CandleChart', () => ({
  CandleChart: (props: {
    overlays: Array<{ id: string; gaps?: boolean }>;
    indicatorFills: unknown[];
    indicatorProfileRows: Array<{ volume: number }>;
    onVisibleCandleViewport?: (viewport: unknown) => void;
  }) =>
    createElement('div', {
      'data-testid': 'candle-chart',
      'data-overlay-ids': props.overlays.map(({ id }) => id).join(','),
      'data-segmented-count': props.overlays.filter(({ gaps }) => gaps).length,
      'data-fill-count': props.indicatorFills.length,
      'data-profile-count': props.indicatorProfileRows.length,
      'data-profile-volume': props.indicatorProfileRows.reduce(
        (total, row) => total + row.volume,
        0,
      ),
      'data-visible-candle-range-handler': typeof props.onVisibleCandleViewport === 'function',
    }),
}));

vi.mock('./IndicatorPane', () => ({
  IndicatorPane: (props: {
    series: Array<{ kind: string }>;
    guideLines?: number[];
    yRange?: [number, number];
  }) =>
    createElement('div', {
      'data-testid': 'indicator-pane',
      'data-series-kinds': props.series.map(({ kind }) => kind).join(','),
      'data-guide-lines': props.guideLines?.join(',') ?? '',
      'data-y-range': props.yRange?.join(',') ?? '',
    }),
}));

vi.mock('./DrawingToolbar', () => ({
  DrawToolsMenu: () => createElement('div', { 'data-testid': 'draw-tools-menu' }),
  DrawToolsRail: () => createElement('div', { 'data-testid': 'draw-tools-rail' }),
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

function makeStore(overrides: Partial<ChartStoreState> = {}) {
  const state = { ...baseState(), ...overrides };
  return {
    getState: () => state,
    subscribe: () => () => undefined,
    selectInterval: vi.fn(),
    loadCandles: vi.fn(),
  } as unknown as ChartStore;
}

function baseState(): ChartStoreState {
  return {
    symbol: 'SPY',
    interval: '1m' as const,
    candles: [] as ChartCandle[],
    quote: {
      symbol: 'SPY',
      bid: 728.4,
      ask: 728.84,
      last: 728,
      bidSize: 1,
      askSize: 1,
      volume: 0,
      timestamp: new Date().toISOString(),
    },
    isLoading: false,
    errorMessage: null,
    isStale: false,
    l2: { kind: 'unavailable' as const, reason: 'Level 2 capability is disabled', isStale: false },
    visibleCandleViewport: { kind: 'uninitialized' } as VisibleCandleViewport,
    indicatorSettings: {
      ...DEFAULT_INDICATOR_SETTINGS_STATE,
      indicators: Object.fromEntries(
        Object.entries(DEFAULT_INDICATOR_SETTINGS_STATE.indicators).map(([id, setting]) => [
          id,
          { ...setting, enabled: false },
        ]),
      ) as IndicatorSettingsState['indicators'],
    },
    chartDisplay: { ...DEFAULT_CHART_DISPLAY, volumeEnabled: false },
    twcSettings: { ...DEFAULT_TWC_SETTINGS, enabled: false },
    usrSettings: { ...DEFAULT_USR_SETTINGS, enabled: false },
    optionsAnalytics: { ...DEFAULT_OPTIONS_ANALYTICS_SETTINGS, enabled: false },
    tickProgress: null,
    revealPrice: null,
    visiblePriceRange: null,
  };
}

async function renderChart(
  overrides: Partial<ChartStoreState> = {},
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

  it('consumes generic line, multiline, band, cloud, segmented, histogram, and profile models', async () => {
    const indicators = structuredClone(DEFAULT_INDICATOR_SETTINGS_STATE.indicators);
    for (const setting of Object.values(indicators)) setting.enabled = false;
    for (const id of ['sma', 'macd', 'bollinger', 'ichimoku', 'supertrend', 'vpvr'] as const) {
      indicators[id].enabled = true;
    }
    // L2 histogram remains explicitly unavailable and must not fabricate a zero series.
    indicators.top_book_imbalance.enabled = true;
    const candles = Array.from({ length: 60 }, (_, index) => ({
      time: 1_704_205_800 + index * 60,
      open: 100 + index,
      high: 102 + index,
      low: 99 + index,
      close: 101 + index,
      volume: 100 + index,
    }));

    const markup = await renderChart({
      candles,
      indicatorSettings: { registryVersion: 1, indicators },
    });

    expect(markup).toContain('sma:value');
    expect(markup).toContain('bollinger:upper');
    expect(markup).toContain('ichimoku:spanA');
    expect(markup).toContain('supertrend:bullish');
    expect(markup).toContain('data-segmented-count="2"');
    expect(markup).toContain('data-fill-count="2"');
    expect(markup).toMatch(/data-profile-count="[1-9][0-9]*"/);
    expect(markup).toContain('data-series-kinds="line,line,histogram"');
    expect(markup).not.toContain('top_book_imbalance:value');
    expect(markup).toContain('No L2 data — Level 2 capability is disabled');
  });

  it('renders published L2 values and replaces a stale book with an explicit reason', async () => {
    const indicators = structuredClone(DEFAULT_INDICATOR_SETTINGS_STATE.indicators);
    for (const setting of Object.values(indicators)) setting.enabled = false;
    indicators.top_book_imbalance.enabled = true;
    const candles = [{ time: 1, open: 10, high: 11, low: 9, close: 10, volume: 100 }];
    const available = await renderChart({
      candles,
      indicatorSettings: { registryVersion: 1, indicators },
      l2: {
        kind: 'available',
        snapshot: {
          symbol: 'SPY',
          provider: 'webull',
          capability: 'nasdaq_totalview_non_display',
          freshness: 'fresh',
          timestamp: '2026-08-05T14:30:00.000Z',
          receivedAt: '2026-08-05T14:30:00.500Z',
          depth: 1,
          bids: [{ price: 10, size: 5 }],
          asks: [{ price: 10.01, size: 4 }],
        },
        indicators: {
          spreadAbs: 0.01,
          spreadBps: 9.995,
          spreadPercentile: 0.4,
          topBookImbalance: 0.111,
          tickPressure: null,
          depthImbalance: null,
          cumulativePressure: null,
          touchDepletion: null,
        },
      },
    });
    expect(available).toContain('data-series-kinds="histogram"');
    expect(available).toContain('0.11');
    expect(available).not.toContain('No L2 data');

    const stale = await renderChart({
      candles,
      indicatorSettings: { registryVersion: 1, indicators },
      l2: { kind: 'unavailable', reason: 'Last book is older than five seconds', isStale: true },
    });
    expect(stale).toContain('No L2 data — stale: Last book is older than five seconds');
    expect(stale).not.toContain('data-series-kinds="histogram"');
  });

  it('recomputes VPVR from the current visible candle window and wires viewport reporting', async () => {
    const indicators = structuredClone(DEFAULT_INDICATOR_SETTINGS_STATE.indicators);
    for (const setting of Object.values(indicators)) setting.enabled = false;
    indicators.vpvr.enabled = true;
    indicators.vpvr.parameters.rowCount = 4;
    const candles = [
      { time: 1, open: 10, high: 11, low: 9, close: 10, volume: 100 },
      { time: 2, open: 11, high: 12, low: 10, close: 11, volume: 200 },
      { time: 3, open: 30, high: 31, low: 29, close: 30, volume: 300 },
      { time: 4, open: 31, high: 32, low: 30, close: 31, volume: 400 },
    ];

    const firstWindow = await renderChart({
      candles,
      visibleCandleViewport: { kind: 'range' as const, from: 0, to: 1 },
      indicatorSettings: { registryVersion: 1, indicators },
    });
    const secondWindow = await renderChart({
      candles,
      visibleCandleViewport: { kind: 'range' as const, from: 2, to: 3 },
      indicatorSettings: { registryVersion: 1, indicators },
    });

    expect(firstWindow).toContain('data-profile-volume="300"');
    expect(secondWindow).toContain('data-profile-volume="700"');
    expect(firstWindow).toContain('data-visible-candle-range-handler="true"');
  });

  it('renders an empty VPVR when a valid viewport intersects no loaded candles', async () => {
    const indicators = structuredClone(DEFAULT_INDICATOR_SETTINGS_STATE.indicators);
    for (const setting of Object.values(indicators)) setting.enabled = false;
    indicators.vpvr.enabled = true;

    const markup = await renderChart({
      candles: [
        { time: 1, open: 10, high: 11, low: 9, close: 10, volume: 100 },
        { time: 2, open: 11, high: 12, low: 10, close: 11, volume: 200 },
      ],
      visibleCandleViewport: { kind: 'empty' },
      indicatorSettings: { registryVersion: 1, indicators },
    });

    expect(markup).toContain('data-profile-count="0"');
    expect(markup).toContain('data-profile-volume="0"');
  });

  it('rejects a corrupt third subpane at the render boundary with the canonical message', async () => {
    const indicators = structuredClone(DEFAULT_INDICATOR_SETTINGS_STATE.indicators);
    for (const setting of Object.values(indicators)) setting.enabled = false;
    indicators.rsi.enabled = true;
    indicators.macd.enabled = true;
    indicators.atr.enabled = true;

    const markup = await renderChart({
      candles: [{ time: 1, open: 10, high: 11, low: 9, close: 10, volume: 100 }],
      indicatorSettings: { registryVersion: 1, indicators },
    });

    expect(markup).toContain('You can display up to 2 indicator panes.');
    expect(markup).not.toContain('data-testid="indicator-pane"');
  });

  it('rejects corrupt unavailable L2 subpanes through the same render boundary', async () => {
    const indicators = structuredClone(DEFAULT_INDICATOR_SETTINGS_STATE.indicators);
    for (const setting of Object.values(indicators)) setting.enabled = false;
    indicators.spread.enabled = true;
    indicators.top_book_imbalance.enabled = true;
    indicators.tick_pressure.enabled = true;

    const markup = await renderChart({
      candles: [{ time: 1, open: 10, high: 11, low: 9, close: 10, volume: 100 }],
      indicatorSettings: { registryVersion: 1, indicators },
      l2: { kind: 'unavailable', reason: 'Level 2 capability is disabled', isStale: false },
    });

    expect(markup).toContain('You can display up to 2 indicator panes.');
    expect(markup).not.toContain('No L2 data');
    expect(markup).not.toContain('Spread');
    expect(markup).not.toContain('Top Book Imbalance');
    expect(markup).not.toContain('Tick Pressure');
  });

  it.each([
    ['rsi', '30,70', '0,100'],
    ['stochastic', '20,80', '0,100'],
    ['williams_r', '-80,-20', '-100,0'],
  ] as const)(
    'passes the canonical %s guides and range to the real pane boundary',
    async (id, guideLines, yRange) => {
      const indicators = structuredClone(DEFAULT_INDICATOR_SETTINGS_STATE.indicators);
      for (const setting of Object.values(indicators)) setting.enabled = false;
      indicators[id].enabled = true;

      const markup = await renderChart({
        candles: [{ time: 1, open: 10, high: 11, low: 9, close: 10, volume: 100 }],
        indicatorSettings: { registryVersion: 1, indicators },
      });

      expect(markup).toContain(`data-guide-lines="${guideLines}"`);
      expect(markup).toContain(`data-y-range="${yRange}"`);
    },
  );

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
