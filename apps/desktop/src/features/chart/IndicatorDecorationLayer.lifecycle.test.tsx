// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IndicatorDecorationLayer } from './IndicatorDecorationLayer';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe('IndicatorDecorationLayer lifecycle', () => {
  let root: Root;
  let container: HTMLDivElement;
  let frames: FrameRequestCallback[];
  const disconnect = vi.fn();
  const observe = vi.fn();
  const context = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    fillStyle: '',
    globalAlpha: 1,
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

  it('repaints on vertical-scale changes and unsubscribes every source on cleanup', async () => {
    let scaleListener: (() => void) | null = null;
    const unsubscribeScale = vi.fn();
    const verticalScaleChanges = {
      subscribe: vi.fn((listener: () => void) => {
        scaleListener = listener;
        return unsubscribeScale;
      }),
      emit: vi.fn(),
    };
    let logicalListener: (() => void) | null = null;
    const unsubscribeLogical = vi.fn();
    const timeScale = {
      logicalToCoordinate: vi.fn((index: number) => index * 10),
      subscribeVisibleLogicalRangeChange: vi.fn((listener: () => void) => {
        logicalListener = listener;
      }),
      unsubscribeVisibleLogicalRangeChange: vi.fn((listener: () => void) => {
        if (listener === logicalListener) unsubscribeLogical();
      }),
    };
    const chart = {
      paneSize: vi.fn(() => ({ width: 200, height: 100 })),
      timeScale: vi.fn(() => timeScale),
    };
    let scale = 1;
    const series = { priceToCoordinate: vi.fn((price: number) => price * scale) };

    await act(async () => {
      root.render(
        createElement(IndicatorDecorationLayer, {
          chart: chart as never,
          series: series as never,
          verticalScaleChanges,
          overlays: [
            { id: 'upper', color: '#fff', values: [12, 13] },
            { id: 'lower', color: '#fff', values: [8, 9] },
          ],
          fills: [
            {
              upperSeriesId: 'upper',
              lowerSeriesId: 'lower',
              color: '#40cbe0',
              opacity: 0.08,
            },
          ],
          profileRows: [
            {
              low: 9,
              high: 10,
              volume: 100,
              inValueArea: true,
              color: '#3b9eff',
              opacity: 0.42,
            },
          ],
        }),
      );
    });

    expect(verticalScaleChanges.subscribe).toHaveBeenCalledOnce();
    expect(frames).toHaveLength(1);
    frames.shift()?.(0);
    expect(context.clearRect).toHaveBeenCalledOnce();

    scale = 2;
    expect(scaleListener).not.toBeNull();
    (scaleListener as unknown as () => void)();
    expect(frames).toHaveLength(1);
    frames.shift()?.(0);
    expect(context.clearRect).toHaveBeenCalledTimes(2);
    expect(series.priceToCoordinate).toHaveBeenCalledWith(10);
    expect(context.fillRect).toHaveBeenLastCalledWith(164, 18, 36, 2);

    await act(async () => root.render(null));
    expect(unsubscribeScale).toHaveBeenCalledOnce();
    expect(unsubscribeLogical).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
