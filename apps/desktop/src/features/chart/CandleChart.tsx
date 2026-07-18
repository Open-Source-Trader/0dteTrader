import { useEffect, useRef } from 'react';
import {
  ColorType,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { CandleInterval } from '@0dtetrader/shared-types';
import type { ChartCandle } from './ChartStore';

export interface OverlaySeries {
  id: string;
  color: string;
  values: (number | null)[];
}

interface CandleChartProps {
  candles: ChartCandle[];
  overlays: OverlaySeries[];
  interval: CandleInterval;
}

// Mirror tokens.css (lightweight-charts needs concrete colors, not CSS vars).
const COLORS = {
  candleUp: '#30d158',
  candleDown: '#ff453a',
  axisLabel: 'rgba(235, 235, 245, 0.6)',
  grid: 'rgba(84, 84, 88, 0.25)',
  border: 'rgba(84, 84, 88, 0.4)',
};

const VISIBLE_CANDLES = 120;

function formatTick(timeSeconds: number, interval: CandleInterval): string {
  const date = new Date(timeSeconds * 1000);
  if (interval === '1d') {
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Candlestick chart with indicator overlays (CandleChartRepresentable analog).
 * Left price axis like the iOS chart; pan/zoom enabled. On data-length change
 * the view snaps to the last 120 bars; in-place tick updates leave the user's
 * pan/zoom alone.
 */
export function CandleChart({ candles, overlays, interval }: CandleChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const overlaySeriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const lastLengthRef = useRef(0);
  const lastFirstTimeRef = useRef<number | null>(null);
  const intervalRef = useRef(interval);
  intervalRef.current = interval;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: COLORS.axisLabel,
        fontSize: 10,
        fontFamily:
          "ui-monospace, 'SF Mono', 'Cascadia Mono', 'JetBrains Mono', 'DejaVu Sans Mono', Menlo, monospace",
      },
      leftPriceScale: { visible: true, borderColor: COLORS.border },
      rightPriceScale: { visible: false },
      timeScale: {
        borderColor: COLORS.border,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: UTCTimestamp) => formatTick(time, intervalRef.current),
      },
      grid: {
        vertLines: { color: COLORS.grid },
        horzLines: { color: COLORS.grid },
      },
      crosshair: {
        vertLine: { visible: false, labelVisible: false },
        horzLine: { visible: false, labelVisible: false },
      },
      autoSize: true,
    });
    const candleSeries = chart.addCandlestickSeries({
      upColor: COLORS.candleUp,
      downColor: COLORS.candleDown,
      wickUpColor: COLORS.candleUp,
      wickDownColor: COLORS.candleDown,
      borderUpColor: COLORS.candleUp,
      borderDownColor: COLORS.candleDown,
      priceScaleId: 'left',
      priceLineVisible: false,
      lastValueVisible: true,
    });
    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      overlaySeriesRef.current = new Map();
      lastLengthRef.current = 0;
      lastFirstTimeRef.current = null;
    };
  }, []);

  // Candle data: full set + snap on structural change, cheap update on ticks.
  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    if (!chart || !series) return;

    const firstTime = candles.length > 0 ? candles[0].time : null;
    const structuralChange =
      candles.length !== lastLengthRef.current || firstTime !== lastFirstTimeRef.current;

    if (structuralChange) {
      series.setData(candles.map(toCandleData));
      if (candles.length > 0) {
        chart.timeScale().setVisibleLogicalRange({
          from: Math.max(0, candles.length - VISIBLE_CANDLES),
          to: candles.length,
        });
      }
    } else if (candles.length > 0) {
      series.update(toCandleData(candles[candles.length - 1]));
    }
    lastLengthRef.current = candles.length;
    lastFirstTimeRef.current = firstTime;
  }, [candles]);

  // Overlay lines: recreate the series set when ids change, reset data otherwise.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const existing = overlaySeriesRef.current;
    const wanted = new Set(overlays.map((overlay) => overlay.id));

    for (const [id, series] of existing) {
      if (!wanted.has(id)) {
        chart.removeSeries(series);
        existing.delete(id);
      }
    }
    for (const overlay of overlays) {
      let series = existing.get(overlay.id);
      if (!series) {
        series = chart.addLineSeries({
          color: overlay.color,
          lineWidth: 1,
          priceScaleId: 'left',
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        existing.set(overlay.id, series);
      }
      const data: LineData[] = [];
      overlay.values.forEach((value, index) => {
        const candle = candles[index];
        if (value !== null && candle) {
          data.push({ time: candle.time as UTCTimestamp, value });
        }
      });
      series.setData(data);
    }
  }, [candles, overlays]);

  return <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />;
}

function toCandleData(candle: ChartCandle): CandlestickData {
  return {
    time: candle.time as UTCTimestamp,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  };
}
