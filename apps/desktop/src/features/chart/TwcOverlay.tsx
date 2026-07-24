import { useEffect, useRef } from 'react';
import type { IChartApi, ISeriesApi, Logical } from 'lightweight-charts';
import type { ChartCandle } from './ChartStore';
import type { TwcRenderModel, TwcSegment } from './twc/twcTypes';

interface TwcOverlayProps {
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  model: TwcRenderModel | null;
  /** Candle data version: live updates shift price→y geometry, so repaint. */
  candles: ChartCandle[];
}

const MARKER_PAD = 6;

/**
 * Read-only canvas overlay for the TWC Heatmap render model: fib level lines,
 * Gann fans/frames, profit-target bands, labels, signal markers and area
 * fills. Same event-driven repaint pattern as DrawingLayer, but with no
 * pointer interaction; bar indices map straight to logical coordinates
 * (indices past the last bar project into the future).
 */
export function TwcOverlay({ chart, series, model, candles }: TwcOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scheduleRef = useRef<() => void>(() => {});
  const modelRef = useRef(model);
  modelRef.current = model;
  const candlesRef = useRef(candles);
  candlesRef.current = candles;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;

    const xAt = (barIndex: number): number | null =>
      chart.timeScale().logicalToCoordinate(barIndex as Logical);
    const yAt = (price: number): number | null => series.priceToCoordinate(price);

    const applyStyle = (ctx: CanvasRenderingContext2D, segment: TwcSegment): void => {
      ctx.strokeStyle = segment.color;
      ctx.lineWidth = segment.width;
      let dash: number[] = [];
      if (segment.style === 'dashed') dash = [5, 4];
      else if (segment.style === 'dotted') dash = [2, 3];
      ctx.setLineDash(dash);
    };

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

      const m = modelRef.current;
      const bars = candlesRef.current;
      if (!m || bars.length === 0) return;

      // ── Area fills (contiguous same-color runs between two series) ──
      for (const fill of m.fills) {
        let run: { x: number; top: number; bottom: number }[] = [];
        let runColor: string | null = null;
        const flush = () => {
          if (run.length >= 2 && runColor) {
            ctx.beginPath();
            ctx.moveTo(run[0].x, run[0].top);
            for (let k = 1; k < run.length; k++) ctx.lineTo(run[k].x, run[k].top);
            for (let k = run.length - 1; k >= 0; k--) ctx.lineTo(run[k].x, run[k].bottom);
            ctx.closePath();
            ctx.fillStyle = runColor;
            ctx.fill();
          }
          run = [];
          runColor = null;
        };
        for (let i = 0; i < bars.length; i++) {
          const top = fill.top[i];
          const bottom = fill.bottom[i];
          const color = fill.colors[i];
          if (top === null || bottom === null || color === null) {
            flush();
            continue;
          }
          if (runColor !== null && color !== runColor) flush();
          const x = xAt(i);
          const yTop = yAt(top);
          const yBottom = yAt(bottom);
          if (x === null || yTop === null || yBottom === null) {
            flush();
            continue;
          }
          runColor = color;
          run.push({ x, top: yTop, bottom: yBottom });
        }
        flush();
      }

      // ── Bands (PT zones, order blocks, premium/discount zones) ──
      for (const band of m.bands) {
        const x1 = xAt(band.x1);
        const x2 = xAt(band.x2);
        const yTop = yAt(band.yTop);
        const yBottom = yAt(band.yBottom);
        if (x1 === null || x2 === null || yTop === null || yBottom === null) continue;
        const rx = Math.min(x1, x2);
        const ry = Math.min(yTop, yBottom);
        const rw = Math.abs(x2 - x1);
        const rh = Math.abs(yBottom - yTop);
        ctx.fillStyle = band.fillColor;
        ctx.fillRect(rx, ry, rw, rh);
        if (band.borderColor) {
          ctx.strokeStyle = band.borderColor;
          ctx.lineWidth = 1;
          ctx.setLineDash([]);
          ctx.strokeRect(rx, ry, rw, rh);
        }
      }

      // ── Segments (fib levels, Gann fans/frames) ──
      for (const segment of m.segments) {
        const x1 = xAt(segment.x1);
        const x2 = xAt(segment.x2);
        const y1 = yAt(segment.y1);
        const y2 = yAt(segment.y2);
        if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
        applyStyle(ctx, segment);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // ── Labels ──
      ctx.font = '10px -apple-system, "SF Pro Text", system-ui, sans-serif';
      for (const label of m.labels) {
        const x = xAt(label.barIndex);
        const y = yAt(label.price);
        if (x === null || y === null) continue;
        const textWidth = ctx.measureText(label.text).width;
        let drawX = x;
        if (label.align === 'center') drawX = x - textWidth / 2;
        else if (label.align === 'right') drawX = x - textWidth;
        if (label.bgColor) {
          ctx.fillStyle = label.bgColor;
          const padX = 6;
          const h = 16;
          roundRect(ctx, drawX - padX, y - h / 2, textWidth + padX * 2, h, 4);
          ctx.fill();
        }
        ctx.fillStyle = label.textColor;
        ctx.fillText(label.text, drawX, y + 3.5);
      }

      // ── Markers (diamonds, triangles, Buy/Sell pills) ──
      for (const marker of m.markers) {
        const bar = bars[marker.barIndex];
        if (!bar) continue;
        const x = xAt(marker.barIndex);
        if (x === null) continue;
        const anchor = marker.placement === 'aboveBar' ? yAt(bar.high) : yAt(bar.low);
        if (anchor === null) continue;
        const dir = marker.placement === 'aboveBar' ? -1 : 1;
        const y = anchor + dir * MARKER_PAD;
        const s = marker.size === 'tiny' ? 4 : 5.5;
        ctx.fillStyle = marker.color;
        if (marker.shape === 'diamond') {
          ctx.beginPath();
          ctx.moveTo(x, y - s + dir * s);
          ctx.lineTo(x + s, y + dir * s);
          ctx.lineTo(x, y + s + dir * s);
          ctx.lineTo(x - s, y + dir * s);
          ctx.closePath();
          ctx.fill();
        } else if (marker.shape === 'triangleUp' || marker.shape === 'triangleDown') {
          // Apex points toward the bar; base extends away from it.
          const base = marker.shape === 'triangleUp' ? y + 2 * s : y - 2 * s;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x - s, base);
          ctx.lineTo(x + s, base);
          ctx.closePath();
          ctx.fill();
        } else {
          // labelUp / labelDown pill with pointer toward the bar
          const text = marker.text ?? '';
          const textWidth = ctx.measureText(text).width;
          const w = textWidth + 12;
          const h = 16;
          const pillY = marker.placement === 'aboveBar' ? y - h - 4 : y + 4;
          roundRect(ctx, x - w / 2, pillY, w, h, 4);
          ctx.fill();
          ctx.beginPath();
          if (marker.placement === 'aboveBar') {
            ctx.moveTo(x - 3, pillY + h);
            ctx.lineTo(x + 3, pillY + h);
            ctx.lineTo(x, pillY + h + 4);
          } else {
            ctx.moveTo(x - 3, pillY);
            ctx.lineTo(x + 3, pillY);
            ctx.lineTo(x, pillY - 4);
          }
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = '#FFFFFF';
          ctx.fillText(text, x - textWidth / 2, pillY + h / 2 + 3.5);
          ctx.fillStyle = marker.color;
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

  // Model or candle changes shift geometry; repaint.
  useEffect(() => {
    scheduleRef.current();
  }, [model, candles]);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', top: 0, left: 0, zIndex: 2, pointerEvents: 'none' }}
      aria-hidden="true"
    />
  );
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
