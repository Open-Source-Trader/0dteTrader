// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChartCandle } from './ChartStore';
import { IndicatorPane, type PaneSeries } from './IndicatorPane';
import { INDICATOR_REGISTRY } from './indicatorRegistry';
import { buildIndicatorRenderModel } from './indicatorRenderModel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const renderer = vi.hoisted(() => {
  const setData = vi.fn();
  const update = vi.fn();
  const lineSeries = {
    setData,
    update,
    createPriceLine: vi.fn(),
  };
  const chart = {
    addSeries: vi.fn(() => lineSeries),
    removeSeries: vi.fn(),
    remove: vi.fn(),
    priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
    timeScale: vi.fn(() => ({ fitContent: vi.fn() })),
  };
  return { chart, lineSeries, setData, update };
});

vi.mock('lightweight-charts', () => ({
  ColorType: { Solid: 'solid' },
  HistogramSeries: Symbol('HistogramSeries'),
  LineSeries: Symbol('LineSeries'),
  createChart: vi.fn(() => renderer.chart),
}));

vi.mock('./chartColors', () => ({
  chartPalette: () => ({ axisLabel: '#ddd', guide: '#888' }),
  indicatorStyleColor: (styleToken: string) =>
    ({
      'indicator.macd.value': '#3b9eff',
      'indicator.macd.signal': '#ff9f0a',
      'indicator.macd.histogram': '#9aa9bc',
      'indicator.top_book_imbalance.value': '#40cbe0',
      'indicator.tick_pressure.value': '#ffc53d',
    })[styleToken] ?? '#8cb4eb',
}));

function candles(times: number[]): ChartCandle[] {
  return times.map((time, index) => ({
    time,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 1000 + index,
  }));
}

function line(values: number[]): PaneSeries[] {
  return [{ id: 'rsi:value', kind: 'line', color: '#f5c542', values }];
}

describe('IndicatorPane mounted series lifecycle', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    renderer.setData.mockClear();
    renderer.update.mockClear();
    renderer.chart.addSeries.mockClear();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('setData replaces historical values after a parameter-only change', async () => {
    await act(async () => {
      root.render(
        createElement(IndicatorPane, {
          height: 72,
          candles: candles([1, 2, 3]),
          series: line([10, 11, 12]),
        }),
      );
    });
    renderer.setData.mockClear();
    renderer.update.mockClear();

    await act(async () => {
      root.render(
        createElement(IndicatorPane, {
          height: 72,
          candles: candles([1, 2, 3]),
          series: line([20, 21, 22]),
        }),
      );
    });

    expect(renderer.setData).toHaveBeenCalledWith([
      { time: 1, value: 20 },
      { time: 2, value: 21 },
      { time: 3, value: 22 },
    ]);
    expect(renderer.update).not.toHaveBeenCalled();
  });

  it('setData replaces equal-length data when the final timestamp moves', async () => {
    await act(async () => {
      root.render(
        createElement(IndicatorPane, {
          height: 72,
          candles: candles([1, 2, 3]),
          series: line([10, 11, 12]),
        }),
      );
    });
    renderer.setData.mockClear();
    renderer.update.mockClear();

    await act(async () => {
      root.render(
        createElement(IndicatorPane, {
          height: 72,
          candles: candles([1, 2, 4]),
          series: line([10, 11, 12]),
        }),
      );
    });

    expect(renderer.setData).toHaveBeenCalledWith([
      { time: 1, value: 10 },
      { time: 2, value: 11 },
      { time: 4, value: 12 },
    ]);
    expect(renderer.update).not.toHaveBeenCalled();
  });

  it('keeps the update fast path when only the forming value changes', async () => {
    await act(async () => {
      root.render(
        createElement(IndicatorPane, {
          height: 72,
          candles: candles([1, 2, 3]),
          series: line([10, 11, 12]),
        }),
      );
    });
    renderer.setData.mockClear();
    renderer.update.mockClear();

    await act(async () => {
      root.render(
        createElement(IndicatorPane, {
          height: 72,
          candles: candles([1, 2, 3]),
          series: line([10, 11, 12.5]),
        }),
      );
    });

    expect(renderer.setData).not.toHaveBeenCalled();
    expect(renderer.update).toHaveBeenCalledWith({ time: 3, value: 12.5 });
  });

  it('mounts MACD histogram points with its canonical semantic color', async () => {
    const descriptor = INDICATOR_REGISTRY.indicators.find(({ id }) => id === 'macd')!;
    const model = buildIndicatorRenderModel(descriptor, {
      kind: 'multi_line',
      series: { macd: [1, 2], signal: [0.5, 1.5], histogram: [0.5, -0.5] },
    });

    await act(async () => {
      root.render(
        createElement(IndicatorPane, {
          height: 72,
          candles: candles([1, 2]),
          series: model.paneSeries,
        }),
      );
    });

    expect(renderer.setData).toHaveBeenCalledWith([
      { time: 1, value: 0.5, color: '#9aa9bc' },
      { time: 2, value: -0.5, color: '#9aa9bc' },
    ]);
  });

  it.each([
    ['top_book_imbalance', '#40cbe0'],
    ['tick_pressure', '#ffc53d'],
  ] as const)('mounts %s histogram points with its canonical semantic color', async (id, color) => {
    const descriptor = INDICATOR_REGISTRY.indicators.find((candidate) => candidate.id === id)!;
    const model = buildIndicatorRenderModel(descriptor, {
      kind: 'histogram',
      series: { value: [0.5, -0.5] },
    });

    await act(async () => {
      root.render(
        createElement(IndicatorPane, {
          height: 72,
          candles: candles([1, 2]),
          series: model.paneSeries,
        }),
      );
    });

    expect(renderer.setData).toHaveBeenCalledWith([
      { time: 1, value: 0.5, color },
      { time: 2, value: -0.5, color },
    ]);
  });
});
