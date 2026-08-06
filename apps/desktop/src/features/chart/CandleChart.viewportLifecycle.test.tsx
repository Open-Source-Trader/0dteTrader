// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawingsStore } from './drawings';
import { CandleChart } from './CandleChart';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const renderer = vi.hoisted(() => {
  const subscribeViewport = vi.fn();
  const unsubscribeViewport = vi.fn();
  const timeScale = {
    subscribeVisibleLogicalRangeChange: subscribeViewport,
    unsubscribeVisibleLogicalRangeChange: unsubscribeViewport,
    getVisibleLogicalRange: vi.fn(() => ({ from: 0, to: 1 })),
    setVisibleLogicalRange: vi.fn(),
    getVisibleRange: vi.fn(() => null),
    setVisibleRange: vi.fn(),
  };
  const priceScale = {
    options: vi.fn(() => ({ autoScale: true })),
    applyOptions: vi.fn(),
    getVisibleRange: vi.fn(() => ({ from: 90, to: 110 })),
    setVisibleRange: vi.fn(),
  };
  const candleSeries = {
    setData: vi.fn(),
    update: vi.fn(),
    createPriceLine: vi.fn(),
    removePriceLine: vi.fn(),
    applyOptions: vi.fn(),
  };
  const chart = {
    addSeries: vi.fn(() => candleSeries),
    removeSeries: vi.fn(),
    remove: vi.fn(),
    applyOptions: vi.fn(),
    timeScale: vi.fn(() => timeScale),
    priceScale: vi.fn(() => priceScale),
  };
  return { chart, timeScale, subscribeViewport, unsubscribeViewport };
});

vi.mock('lightweight-charts', () => ({
  CandlestickSeries: Symbol('CandlestickSeries'),
  ColorType: { Solid: 'solid' },
  HistogramSeries: Symbol('HistogramSeries'),
  LineSeries: Symbol('LineSeries'),
  LineStyle: { Dotted: 1 },
  createChart: vi.fn(() => renderer.chart),
}));

vi.mock('./chartColors', () => ({
  chartPalette: () => ({
    axisLabel: '#ddd',
    crosshair: '#888',
    candleUp: '#0f0',
    candleDown: '#f00',
    accent: '#00f',
    volumeUp: '#0f0',
    volumeDown: '#f00',
  }),
}));
vi.mock('./FloatingAxes', () => ({ FloatingAxes: () => null }));
vi.mock('./DrawingLayer', () => ({ DrawingLayer: () => null }));
vi.mock('./OrderLineLayer', () => ({ OrderLineLayer: () => null }));
vi.mock('./TwcOverlay', () => ({ TwcOverlay: () => null }));
vi.mock('./VolumeWeightedCandleOverlay', () => ({ VolumeWeightedCandleOverlay: () => null }));
vi.mock('./IndicatorDecorationLayer', () => ({ IndicatorDecorationLayer: () => null }));
vi.mock('./optionsAnalytics/OptionsAnalyticsOverlay', () => ({
  OptionsAnalyticsOverlay: () => null,
}));

function candles(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    time: index + 1,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 1000 + index,
  }));
}

describe('CandleChart viewport reporting lifecycle', () => {
  let root: Root;
  let container: HTMLDivElement;
  let frames: FrameRequestCallback[];
  const onVisibleCandleViewport = vi.fn();
  const drawingsStore = new DrawingsStore();

  beforeEach(() => {
    frames = [];
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('keeps one subscription and never clears the viewport during candle-length changes', async () => {
    const props = {
      overlays: [],
      symbol: 'SPY',
      interval: '1m' as const,
      showVolume: false,
      volumeWeightedCandleWidth: false,
      drawingsStore,
      onVisibleCandleViewport,
    };
    await act(async () => {
      root.render(createElement(CandleChart, { ...props, candles: candles(2) }));
    });
    frames.splice(0).forEach((callback) => callback(0));
    onVisibleCandleViewport.mockClear();

    await act(async () => {
      root.render(createElement(CandleChart, { ...props, candles: candles(3) }));
    });

    expect(renderer.subscribeViewport).toHaveBeenCalledOnce();
    expect(renderer.unsubscribeViewport).not.toHaveBeenCalled();
    expect(onVisibleCandleViewport).not.toHaveBeenCalledWith({ kind: 'uninitialized' });
    frames.splice(0).forEach((callback) => callback(0));
    expect(onVisibleCandleViewport).toHaveBeenLastCalledWith({ kind: 'range', from: 0, to: 1 });
    expect(onVisibleCandleViewport).not.toHaveBeenCalledWith({ kind: 'uninitialized' });
  });

  it('keeps the series body opaque when volume-weighted width is off, and hides it when on', async () => {
    const props = {
      overlays: [],
      symbol: 'SPY',
      interval: '1m' as const,
      showVolume: false,
      drawingsStore,
      onVisibleCandleViewport,
    };

    await act(async () => {
      root.render(
        createElement(CandleChart, {
          ...props,
          candles: candles(2),
          volumeWeightedCandleWidth: false,
        }),
      );
    });
    expect(renderer.chart.addSeries).toHaveBeenCalled();
    const candleSeries = renderer.chart.addSeries.mock.results[0]?.value as {
      applyOptions: ReturnType<typeof vi.fn>;
    };
    // The setting starts off: no transparency override has been applied yet.
    expect(candleSeries.applyOptions).not.toHaveBeenCalledWith(
      expect.objectContaining({ upColor: 'rgba(0, 0, 0, 0)' }),
    );

    await act(async () => {
      root.render(
        createElement(CandleChart, {
          ...props,
          candles: candles(2),
          volumeWeightedCandleWidth: true,
        }),
      );
    });
    expect(candleSeries.applyOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        upColor: 'rgba(0, 0, 0, 0)',
        downColor: 'rgba(0, 0, 0, 0)',
        borderVisible: false,
      }),
    );

    await act(async () => {
      root.render(
        createElement(CandleChart, {
          ...props,
          candles: candles(2),
          volumeWeightedCandleWidth: false,
        }),
      );
    });
    expect(candleSeries.applyOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ upColor: '#0f0', downColor: '#f00', borderVisible: true }),
    );
  });
});
