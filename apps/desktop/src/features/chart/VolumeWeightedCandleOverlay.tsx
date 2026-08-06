import { useEffect, useRef } from 'react';
import type { IChartApi, ISeriesApi, Logical } from 'lightweight-charts';
import { calculateVolumeWeightedWidth, referenceVolume } from './candleWidth';
import { normalizeVisibleCandleViewport } from './candleViewport';
import { chartPalette } from './chartColors';
import type { ChartCandle } from './ChartStore';

interface VolumeWeightedCandleOverlayProps {
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  /** Candle data version: live updates shift both price→y and volume geometry. */
  candles: ChartCandle[];
  /** Per-bar TWC regime repaint colors; null cells fall back to up/down color. */
  candleColors?: (string | null)[] | null;
}

const MINIMUM_WIDTH_RATIO = 0.2;
const MAXIMUM_WIDTH_RATIO = 0.95;

/**
 * Read-only canvas overlay that paints volume-weighted candle bodies on top
 * of the (body-hidden) built-in CandlestickSeries. Same event-driven repaint
 * pattern as TwcOverlay: bar indices map straight to logical coordinates, and
 * the reference volume is recomputed only on an actual repaint (range/data/
 * resize change), never per-candle.
 */
export function VolumeWeightedCandleOverlay({
  chart,
  series,
  candles,
  candleColors = null,
}: VolumeWeightedCandleOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scheduleRef = useRef<() => void>(() => {});
  const candlesRef = useRef(candles);
  candlesRef.current = candles;
  const candleColorsRef = useRef(candleColors);
  candleColorsRef.current = candleColors;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;

    const xAt = (barIndex: number): number | null =>
      chart.timeScale().logicalToCoordinate(barIndex as Logical);
    const yAt = (price: number): number | null => series.priceToCoordinate(price);

    const draw = () => {
      const pane = chart.paneSize();
      const axisWidth = chart.priceScale('left').width();
      const dpr = window.devicePixelRatio || 1;
      canvas.style.left = `${axisWidth}px`;
      canvas.style.width = `${pane.width}px`;
      canvas.style.height = `${pane.height}px`;
      if (canvas.width !== pane.width * dpr || canvas.height !== pane.height * dpr) {
        canvas.width = pane.width * dpr;
        canvas.height = pane.height * dpr;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, pane.width, pane.height);

      const bars = candlesRef.current;
      if (bars.length === 0) return;

      const viewport = normalizeVisibleCandleViewport(
        chart.timeScale().getVisibleLogicalRange(),
        bars.length,
      );
      if (viewport.kind !== 'range') return;

      const visibleVolumes: number[] = [];
      for (let i = viewport.from; i <= viewport.to; i++) visibleVolumes.push(bars[i].volume);
      const refVolume = referenceVolume(visibleVolumes);

      // Pixel spacing between adjacent bars at the current zoom level; falls
      // back to a sane default if the two coordinates can't be resolved (e.g.
      // a single visible candle at the edge of the pane).
      const x0 = xAt(viewport.from);
      const x1 = xAt(viewport.from + 1);
      const normalCandleWidth = x0 !== null && x1 !== null ? Math.abs(x1 - x0) : 6;

      const colors = chartPalette();
      const regimeColors = candleColorsRef.current;

      for (let i = viewport.from; i <= viewport.to; i++) {
        const bar = bars[i];
        const centerX = xAt(i);
        const openY = yAt(bar.open);
        const closeY = yAt(bar.close);
        if (centerX === null || openY === null || closeY === null) continue;

        const width = calculateVolumeWeightedWidth({
          volume: bar.volume,
          referenceVolume: refVolume,
          normalCandleWidth,
          minimumWidthRatio: MINIMUM_WIDTH_RATIO,
          maximumWidthRatio: MAXIMUM_WIDTH_RATIO,
        });

        const color =
          regimeColors?.[i] ?? (bar.close >= bar.open ? colors.candleUp : colors.candleDown);
        const top = Math.min(openY, closeY);
        // Doji (open === close): draw a thin flat body, matching the built-in
        // series' own doji treatment, instead of a zero-height invisible rect.
        const height = Math.max(1, Math.abs(closeY - openY));

        // Snap to whole device pixels: lightweight-charts' own candles render
        // crisp because they align to the pixel grid, while unsnapped
        // fractional rects blur under anti-aliasing (the "muddy" look at
        // narrow, volume-weighted widths). Snapping the edges rather than the
        // center keeps width as close to the computed value as a whole pixel
        // count allows while staying visually centered.
        const left = Math.round(centerX - width / 2);
        const right = Math.max(left + 1, Math.round(centerX + width / 2));
        const snappedTop = Math.round(top);
        const snappedHeight = Math.max(1, Math.round(top + height) - snappedTop);

        ctx.fillStyle = color;
        ctx.fillRect(left, snappedTop, right - left, snappedHeight);
        // A hairline border in the body's own color, matching the built-in
        // series (borderUpColor/borderDownColor = up/down color): it's what
        // separates one candle's edge from its neighbor instead of a flat,
        // borderless fill reading as a single smeared block at narrow widths.
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(left + 0.5, snappedTop + 0.5, right - left - 1, snappedHeight - 1);
      }
    };

    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        draw();
      });
    };
    scheduleRef.current = schedule;

    chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(canvas.parentElement as Element);
    schedule();

    return () => {
      scheduleRef.current = () => {};
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(schedule);
      resizeObserver.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [chart, series]);

  // Candle data or regime-color changes shift geometry/paint; repaint.
  useEffect(() => {
    scheduleRef.current();
  }, [candles, candleColors]);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', top: 0, left: 0, zIndex: 1, pointerEvents: 'none' }}
      aria-hidden="true"
    />
  );
}
