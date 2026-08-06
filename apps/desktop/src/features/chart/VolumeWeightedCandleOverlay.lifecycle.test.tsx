// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VolumeWeightedCandleOverlay } from './VolumeWeightedCandleOverlay';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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

function candle(index: number, volume: number, open = 100, close = 101) {
  return {
    time: index,
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume,
  };
}

describe('VolumeWeightedCandleOverlay lifecycle', () => {
  let root: Root;
  let container: HTMLDivElement;
  let frames: FrameRequestCallback[];
  const disconnect = vi.fn();
  const observe = vi.fn();
  const context = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
  };

  beforeEach(() => {
    frames = [];
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = observe;
        disconnect = disconnect;
      },
    );
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function buildChart() {
    let logicalListener: (() => void) | null = null;
    const unsubscribeLogical = vi.fn();
    const timeScale = {
      // 10px per bar, matching the IndicatorDecorationLayer test's convention.
      logicalToCoordinate: vi.fn((index: number) => index * 10),
      getVisibleLogicalRange: vi.fn(() => ({ from: 0, to: 2 })),
      subscribeVisibleLogicalRangeChange: vi.fn((listener: () => void) => {
        logicalListener = listener;
      }),
      unsubscribeVisibleLogicalRangeChange: vi.fn((listener: () => void) => {
        if (listener === logicalListener) unsubscribeLogical();
      }),
    };
    const priceScale = { width: vi.fn(() => 0) };
    const chart = {
      paneSize: vi.fn(() => ({ width: 200, height: 100 })),
      timeScale: vi.fn(() => timeScale),
      priceScale: vi.fn(() => priceScale),
    };
    const series = { priceToCoordinate: vi.fn((price: number) => price) };
    return {
      chart,
      timeScale,
      series,
      unsubscribeLogical,
      getLogicalListener: () => logicalListener,
    };
  }

  it('paints a wider body for a higher-volume candle at an unchanged center', async () => {
    const { chart, series } = buildChart();
    const candles = [candle(0, 10), candle(1, 1000), candle(2, 10)];

    await act(async () => {
      root.render(
        createElement(VolumeWeightedCandleOverlay, {
          chart: chart as never,
          series: series as never,
          candles,
        }),
      );
    });

    expect(frames).toHaveLength(1);
    frames.shift()?.(0);

    // logicalToCoordinate spacing is 10px/bar; centers are 0, 10, 20.
    const calls = context.fillRect.mock.calls as [number, number, number, number][];
    expect(calls).toHaveLength(3);
    const [lowVolRect, highVolRect, lowVolRect2] = calls;

    // Centers unchanged regardless of width: centerX - width/2 + width/2 == centerX.
    expect(lowVolRect[0] + lowVolRect[2] / 2).toBeCloseTo(0);
    expect(highVolRect[0] + highVolRect[2] / 2).toBeCloseTo(10);
    expect(lowVolRect2[0] + lowVolRect2[2] / 2).toBeCloseTo(20);

    // The 1000-volume candle (>= p95 reference) is wider than the 10-volume candles.
    expect(highVolRect[2]).toBeGreaterThan(lowVolRect[2]);
    expect(highVolRect[2]).toBeGreaterThan(lowVolRect2[2]);
  });

  it('draws nothing when there are no candles', async () => {
    const { chart, series } = buildChart();

    await act(async () => {
      root.render(
        createElement(VolumeWeightedCandleOverlay, {
          chart: chart as never,
          series: series as never,
          candles: [],
        }),
      );
    });

    frames.shift()?.(0);
    expect(context.clearRect).toHaveBeenCalledOnce();
    expect(context.fillRect).not.toHaveBeenCalled();
  });

  it('falls back to normal width for all candles when every visible volume is zero', async () => {
    const { chart, series } = buildChart();
    const candles = [candle(0, 0), candle(1, 0), candle(2, 0)];

    await act(async () => {
      root.render(
        createElement(VolumeWeightedCandleOverlay, {
          chart: chart as never,
          series: series as never,
          candles,
        }),
      );
    });

    frames.shift()?.(0);
    const calls = context.fillRect.mock.calls as [number, number, number, number][];
    expect(calls).toHaveLength(3);
    // normalCandleWidth is 10 (spacing); with reference volume 0 every candle
    // falls back to the fixed width rather than collapsing to the minimum.
    for (const [, , width] of calls) expect(width).toBeCloseTo(10);
  });

  it('handles a single visible candle without throwing', async () => {
    const { chart, series } = buildChart();
    chart.timeScale().getVisibleLogicalRange = vi.fn(() => ({ from: 0, to: 0 }));
    const candles = [candle(0, 500)];

    await act(async () => {
      root.render(
        createElement(VolumeWeightedCandleOverlay, {
          chart: chart as never,
          series: series as never,
          candles,
        }),
      );
    });

    expect(() => frames.shift()?.(0)).not.toThrow();
  });

  it('repaints on candle-data changes and unsubscribes everything on unmount', async () => {
    const { chart, series, unsubscribeLogical } = buildChart();
    const candles = [candle(0, 10), candle(1, 20)];

    await act(async () => {
      root.render(
        createElement(VolumeWeightedCandleOverlay, {
          chart: chart as never,
          series: series as never,
          candles,
        }),
      );
    });
    frames.shift()?.(0);
    expect(context.clearRect).toHaveBeenCalledOnce();

    await act(async () => {
      root.render(
        createElement(VolumeWeightedCandleOverlay, {
          chart: chart as never,
          series: series as never,
          candles: [...candles, candle(2, 30)],
        }),
      );
    });
    expect(frames).toHaveLength(1);
    frames.shift()?.(0);
    expect(context.clearRect).toHaveBeenCalledTimes(2);

    await act(async () => root.render(null));
    expect(unsubscribeLogical).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
