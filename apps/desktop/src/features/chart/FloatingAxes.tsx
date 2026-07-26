import { useEffect, useRef } from 'react';
import type { ChartInterval } from '@0dtetrader/shared-types';
import type { IChartApi, ISeriesApi, Logical } from 'lightweight-charts';
import { formatTick, priceTicks, timeTickIndices } from './axisTicks';
import { chartPalette } from './chartColors';
import type { ChartCandle } from './ChartStore';

interface FloatingAxesProps {
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  candles: ChartCandle[];
  interval: ChartInterval;
}

const PRICE_TICKS = 6;
const TIME_TICKS = 6;
/** Gap between a label and the border it sits against. */
const LABEL_INSET = 6;

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
export function FloatingAxes({ chart, series, candles, interval }: FloatingAxesProps) {
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
          drawLabel(ctx, value.toFixed(decimals), LABEL_INSET, y - 4, colors.axisLabel);
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

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', top: 0, left: 0, zIndex: 1, pointerEvents: 'none' }}
      aria-hidden="true"
    />
  );
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
): void {
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
  ctx.shadowBlur = 4;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}
