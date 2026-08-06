// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FloatingAxes } from './FloatingAxes';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock('./chartColors', () => ({
  chartPalette: () => ({ grid: '#123', axisLabel: '#fff' }),
}));

describe('FloatingAxes vertical-scale drag', () => {
  let root: Root;
  let container: HTMLDivElement;
  let mounted: boolean;
  const setVisibleRange = vi.fn();
  const setAutoScale = vi.fn();
  const onVerticalScaleChange = vi.fn();
  const context = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    setLineDash: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    measureText: vi.fn(() => ({ width: 30 })),
    save: vi.fn(),
    restore: vi.fn(),
    strokeText: vi.fn(),
    fillText: vi.fn(),
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    mounted = true;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      right: 200,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    vi.clearAllMocks();
  });

  afterEach(async () => {
    window.dispatchEvent(new MouseEvent('pointerup'));
    if (mounted) await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('publishes every manual visible-range change for decoration repainting', async () => {
    await mountAxes();

    container.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 50 }),
    );
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 75 }));

    expect(setAutoScale).toHaveBeenCalledWith(false);
    expect(setVisibleRange).toHaveBeenCalledOnce();
    expect(onVerticalScaleChange).toHaveBeenCalledOnce();
  });

  it.each(['pointerup', 'pointercancel', 'blur'] as const)(
    'stops an active drag on window %s',
    async (terminalEvent) => {
      await mountAxes();
      container.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 50 }),
      );
      window.dispatchEvent(new Event(terminalEvent));
      setVisibleRange.mockClear();
      onVerticalScaleChange.mockClear();

      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 75 }));

      expect(setVisibleRange).not.toHaveBeenCalled();
      expect(onVerticalScaleChange).not.toHaveBeenCalled();
    },
  );

  it('removes an active drag listener when the axes unmount', async () => {
    await mountAxes();
    container.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 50 }),
    );

    await act(async () => root.unmount());
    mounted = false;
    setVisibleRange.mockClear();
    onVerticalScaleChange.mockClear();
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 75 }));

    expect(setVisibleRange).not.toHaveBeenCalled();
    expect(onVerticalScaleChange).not.toHaveBeenCalled();
  });

  async function mountAxes(): Promise<void> {
    const timeScale = {
      subscribeVisibleLogicalRangeChange: vi.fn(),
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
      getVisibleLogicalRange: vi.fn(() => ({ from: 0, to: 2 })),
      logicalToCoordinate: vi.fn((index: number) => index * 50),
    };
    const chart = {
      paneSize: vi.fn(() => ({ width: 200, height: 100 })),
      timeScale: vi.fn(() => timeScale),
      priceScale: vi.fn(() => ({
        getVisibleRange: vi.fn(() => ({ from: 90, to: 110 })),
        setVisibleRange,
        setAutoScale,
      })),
    };
    const series = {
      coordinateToPrice: vi.fn((coordinate: number) => 110 - coordinate / 5),
      priceToCoordinate: vi.fn((price: number) => (110 - price) * 5),
    };

    await act(async () => {
      root.render(
        createElement(FloatingAxes, {
          chart: chart as never,
          series: series as never,
          candles: [
            { time: 1, open: 100, high: 102, low: 99, close: 101, volume: 10 },
            { time: 2, open: 101, high: 103, low: 100, close: 102, volume: 20 },
          ],
          interval: '1m',
          onVerticalScaleChange,
        }),
      );
    });
  }
});
