import { useEffect, useRef } from 'react';
import type { IChartApi, ISeriesApi, Logical } from 'lightweight-charts';
import type { OverlaySeries } from './CandleChart';
import type { ChartRepaintSignal } from './chartRepaintSignal';
import type { IndicatorFill, IndicatorProfileDecorationRow } from './indicatorRenderModel';

interface IndicatorDecorationLayerProps {
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  verticalScaleChanges: ChartRepaintSignal;
  overlays: OverlaySeries[];
  fills: IndicatorFill[];
  profileRows: IndicatorProfileDecorationRow[];
}

/** Canvas-only decoration for descriptor geometry that lightweight-charts
 * cannot express as ordinary line series: band/cloud fills and VPVR rows. */
export function IndicatorDecorationLayer({
  chart,
  series,
  verticalScaleChanges,
  overlays,
  fills,
  profileRows,
}: IndicatorDecorationLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame = 0;
    const draw = () => {
      frame = 0;
      const pane = chart.paneSize();
      const ratio = window.devicePixelRatio || 1;
      canvas.style.width = `${pane.width}px`;
      canvas.style.height = `${pane.height}px`;
      if (canvas.width !== pane.width * ratio || canvas.height !== pane.height * ratio) {
        canvas.width = pane.width * ratio;
        canvas.height = pane.height * ratio;
      }
      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, pane.width, pane.height);
      const byId = new Map(overlays.map((overlay) => [overlay.id, overlay]));

      for (const fill of fills) {
        const upper = byId.get(fill.upperSeriesId)?.values;
        const lower = byId.get(fill.lowerSeriesId)?.values;
        if (!upper || !lower) continue;
        let run: Array<{ x: number; upper: number; lower: number }> = [];
        const flush = () => {
          if (run.length >= 2) {
            context.beginPath();
            context.moveTo(run[0].x, run[0].upper);
            for (let index = 1; index < run.length; index += 1) {
              context.lineTo(run[index].x, run[index].upper);
            }
            for (let index = run.length - 1; index >= 0; index -= 1) {
              context.lineTo(run[index].x, run[index].lower);
            }
            context.closePath();
            context.save();
            context.fillStyle = fill.color;
            context.globalAlpha = fill.opacity;
            context.fill();
            context.restore();
          }
          run = [];
        };
        for (let index = 0; index < Math.min(upper.length, lower.length); index += 1) {
          const upperValue = upper[index];
          const lowerValue = lower[index];
          const x = chart.timeScale().logicalToCoordinate(index as Logical);
          const upperY = upperValue === null ? null : series.priceToCoordinate(upperValue);
          const lowerY = lowerValue === null ? null : series.priceToCoordinate(lowerValue);
          if (x === null || upperY === null || lowerY === null) {
            flush();
          } else {
            run.push({ x, upper: upperY, lower: lowerY });
          }
        }
        flush();
      }

      const maximumVolume = Math.max(0, ...profileRows.map(({ volume }) => volume));
      if (maximumVolume > 0) {
        const maximumWidth = Math.min(100, pane.width * 0.18);
        for (const row of profileRows) {
          const high = series.priceToCoordinate(row.high);
          const low = series.priceToCoordinate(row.low);
          if (high === null || low === null || row.volume <= 0) continue;
          const width = (row.volume / maximumVolume) * maximumWidth;
          context.save();
          context.fillStyle = row.color;
          context.globalAlpha = row.opacity;
          context.fillRect(
            pane.width - width,
            Math.min(high, low),
            width,
            Math.max(1, Math.abs(low - high)),
          );
          context.restore();
        }
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    schedule();
    chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
    const unsubscribeVerticalScale = verticalScaleChanges.subscribe(schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas.parentElement ?? canvas);
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(schedule);
      unsubscribeVerticalScale();
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [chart, series, verticalScaleChanges, overlays, fills, profileRows]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none' }}
    />
  );
}
