import { useEffect, useRef } from 'react';
import type { ChartInterval } from '@0dtetrader/shared-types';
import type { IChartApi, ISeriesApi, Logical } from 'lightweight-charts';
import { formatTick, priceTicks, timeTickIndices } from './axisTicks';
import { chartPalette } from './chartColors';
import { claimPointer } from './chartPointerClaim';
import type { ChartCandle } from './ChartStore';

interface FloatingAxesProps {
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  candles: ChartCandle[];
  interval: ChartInterval;
  onVerticalScaleChange: () => void;
}

const PRICE_TICKS = 6;
const TIME_TICKS = 6;
/** Gap between a label and the border it sits against. */
const LABEL_INSET = 6;
/** Cap height of a label, at the 11px face both scales are drawn in. */
const LABEL_HEIGHT = 11;
/**
 * Baseline offset that lifts a price label clear of its own grid line, so the
 * digits sit on the line rather than through it.
 */
const PRICE_LABEL_LIFT = 4;
/**
 * Width of the invisible strip along the left edge that acts as the price
 * axis for drag-to-rescale, mirroring TradingView's axis-drag gesture on the
 * (hidden) scale the price labels are drawn over.
 */
const AXIS_DRAG_WIDTH = 44;

/**
 * The price and time scales, drawn over the candles instead of in gutters of
 * their own (the iOS `.insideChart` / `.bottomInside` arrangement).
 *
 * lightweight-charts has no inside-label mode, so both built-in scales are
 * hidden — which is what gives the plot the whole card — and the grid comes
 * from here too, at the same levels as the labels. Text carries the same tight
 * black shadow the quote readout uses, which is what lets a digit sit on a
 * wick without a plate behind it.
 */
export function FloatingAxes({
  chart,
  series,
  candles,
  interval,
  onVerticalScaleChange,
}: FloatingAxesProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scheduleRef = useRef<() => void>(() => {});
  const candlesRef = useRef(candles);
  candlesRef.current = candles;
  const intervalRef = useRef(interval);
  intervalRef.current = interval;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;

    const draw = () => {
      const pane = chart.paneSize();
      const dpr = window.devicePixelRatio || 1;
      canvas.style.left = '0px';
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
      if (pane.width <= 0 || pane.height <= 0) return;

      const colors = chartPalette();
      ctx.font = "11px 'JetBrains Mono', ui-monospace, Menlo, monospace";
      ctx.textBaseline = 'alphabetic';

      // ── Price levels ──
      const top = series.coordinateToPrice(0);
      const bottom = series.coordinateToPrice(pane.height);
      // Both scales print inside the plot, so the bottom-left corner is claimed
      // twice and the lowest price label was drawing over the leftmost time one
      // ("738.0" through "15:20"). The price label yields: the time strip's
      // position is fixed, while the price scale's moves under every tick, so
      // insetting the strip to clear it would mean insetting by the worst case
      // forever. Only the label goes — its grid line stays, so the level is
      // still readable off its neighbours.
      const timeStripTop = pane.height - LABEL_INSET - LABEL_HEIGHT;
      if (top !== null && bottom !== null) {
        const { values, decimals } = priceTicks(bottom, top, PRICE_TICKS);
        for (const value of values) {
          const y = series.priceToCoordinate(value);
          if (y === null) continue;
          ctx.strokeStyle = colors.grid;
          ctx.lineWidth = 1;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(0, Math.round(y) + 0.5);
          ctx.lineTo(pane.width, Math.round(y) + 0.5);
          ctx.stroke();
          const baseline = y - PRICE_LABEL_LIFT;
          if (baseline > timeStripTop) continue;
          drawLabel(ctx, value.toFixed(decimals), LABEL_INSET, baseline, colors.axisLabel);
        }
      }

      // ── Time marks ──
      const range = chart.timeScale().getVisibleLogicalRange();
      const bars = candlesRef.current;
      if (range && bars.length > 0) {
        const indices = timeTickIndices(range.from, range.to, bars.length, TIME_TICKS);
        for (const index of indices) {
          const x = chart.timeScale().logicalToCoordinate(index as Logical);
          const bar = bars[index];
          if (x === null || !bar) continue;
          ctx.strokeStyle = colors.grid;
          ctx.lineWidth = 1;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(Math.round(x) + 0.5, 0);
          ctx.lineTo(Math.round(x) + 0.5, pane.height);
          ctx.stroke();
          const text = formatTick(bar.time, intervalRef.current);
          const width = ctx.measureText(text).width;
          drawLabel(
            ctx,
            text,
            Math.min(Math.max(x - width / 2, LABEL_INSET), pane.width - width - LABEL_INSET),
            pane.height - LABEL_INSET,
            colors.axisLabel,
          );
        }
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

  // Candle changes move the price↔pixel transform under the labels; repaint.
  useEffect(() => {
    scheduleRef.current();
  }, [candles, interval]);

  // Drag-to-rescale on the left edge, where the (hidden) price axis is drawn.
  // lightweight-charts has no visible axis strip to grab here — see the class
  // doc — so this reimplements the gesture: a vertical drag starting within
  // AXIS_DRAG_WIDTH of the left edge stretches/compresses the visible price
  // range around its start point, same feel as dragging TradingView's axis.
  useEffect(() => {
    const canvas = canvasRef.current;
    const containerEl = canvas?.parentElement;
    if (!canvas || !containerEl) return;
    let activeDragCleanup: (() => void) | null = null;

    const stopActiveDrag = () => {
      const cleanup = activeDragCleanup;
      activeDragCleanup = null;
      cleanup?.();
    };

    const onPointerDown = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (x < 0 || x > AXIS_DRAG_WIDTH || y < 0 || y > rect.height) return;
      const priceScale = chart.priceScale('left');
      const startRange = priceScale.getVisibleRange();
      if (!startRange) return;
      const startY = event.clientY;
      const startHeight = rect.height;
      if (startHeight <= 0) return;
      event.preventDefault();
      // Ancestor capture-phase stopPropagation keeps the press from ever
      // reaching the chart's own canvas (native panning) or DrawingLayer's
      // capture listener, both descendants of this container.
      event.stopPropagation();
      stopActiveDrag();
      claimPointer(event);
      priceScale.setAutoScale(false);

      const mid = (startRange.from + startRange.to) / 2;
      const halfSpan = (startRange.to - startRange.from) / 2;

      const onMove = (moveEvent: PointerEvent) => {
        // Dragging down stretches the range (zoom out); up compresses it
        // (zoom in) — matches TradingView's axis-drag direction.
        const dy = moveEvent.clientY - startY;
        const factor = Math.pow(2, dy / startHeight);
        const newHalfSpan = halfSpan * factor;
        priceScale.setVisibleRange({ from: mid - newHalfSpan, to: mid + newHalfSpan });
        scheduleRef.current();
        onVerticalScaleChange();
      };
      const onEnd = () => stopActiveDrag();
      activeDragCleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
        window.removeEventListener('blur', onEnd);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
      window.addEventListener('blur', onEnd);
    };

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const overAxis = x >= 0 && x <= AXIS_DRAG_WIDTH && y >= 0 && y <= rect.height;
      containerEl.style.cursor = overAxis ? 'ns-resize' : '';
    };

    // Capture phase: claims the axis strip before DrawingLayer's own
    // capture listener (or the chart's native panning) sees the press.
    containerEl.addEventListener('pointerdown', onPointerDown, true);
    containerEl.addEventListener('pointermove', onPointerMove);
    return () => {
      stopActiveDrag();
      containerEl.removeEventListener('pointerdown', onPointerDown, true);
      containerEl.removeEventListener('pointermove', onPointerMove);
      containerEl.style.cursor = '';
    };
  }, [chart, onVerticalScaleChange]);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', top: 0, left: 0, zIndex: 1, pointerEvents: 'none' }}
      aria-hidden="true"
    />
  );
}

/** Hard-outline halo (not just a blurred shadow) so a light label stays
 *  legible directly over candle bodies, volume bars, zones, and indicator
 *  lines — a soft shadow alone washes out against a bright green/red candle. */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
): void {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(3, 8, 16, 0.92)';
  ctx.strokeText(text, x, y);
  ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
  ctx.shadowBlur = 3;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}
