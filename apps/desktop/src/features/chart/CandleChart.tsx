import { useEffect, useRef, useState } from 'react';
import {
  ColorType,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { CandleInterval } from '@0dtetrader/shared-types';
import { useStore } from '../../core/observable';
import type { ChartCandle } from './ChartStore';
import { intervalSeconds } from './ChartStore';
import { DrawingLayer } from './DrawingLayer';
import type { DrawingsStore } from './drawings';

export interface OverlaySeries {
  id: string;
  color: string;
  values: (number | null)[];
}

interface CandleChartProps {
  candles: ChartCandle[];
  overlays: OverlaySeries[];
  interval: CandleInterval;
  showVolume: boolean;
  drawingsStore: DrawingsStore;
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
export function CandleChart({
  candles,
  overlays,
  interval,
  showVolume,
  drawingsStore,
}: CandleChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const overlaySeriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const lastLengthRef = useRef(0);
  const lastFirstTimeRef = useRef<number | null>(null);
  const intervalRef = useRef(interval);
  intervalRef.current = interval;
  const [apis, setApis] = useState<{
    chart: IChartApi;
    series: ISeriesApi<'Candlestick'>;
  } | null>(null);
  const { tool } = useStore(drawingsStore);

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
    setApis({ chart, series: candleSeries });
    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      overlaySeriesRef.current = new Map();
      lastLengthRef.current = 0;
      lastFirstTimeRef.current = null;
      setApis(null);
    };
  }, []);

  // Volume histogram on its own compressed scale (bottom 20% of the pane).
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (showVolume && !volumeSeriesRef.current) {
      const series = chart.addHistogramSeries({
        priceScaleId: 'volume',
        priceFormat: { type: 'volume' },
        priceLineVisible: false,
        lastValueVisible: false,
      });
      chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      series.setData(candles.map(toVolumeData));
      volumeSeriesRef.current = series;
    } else if (!showVolume && volumeSeriesRef.current) {
      chart.removeSeries(volumeSeriesRef.current);
      volumeSeriesRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showVolume]);

  // Drawing tools take over the pointer: freeze pan/zoom while one is active.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const interactive = tool === 'cursor';
    chart.applyOptions({ handleScroll: interactive, handleScale: interactive });
  }, [tool]);

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
      volumeSeriesRef.current?.setData(candles.map(toVolumeData));
      if (candles.length > 0) {
        chart.timeScale().setVisibleLogicalRange({
          from: Math.max(0, candles.length - VISIBLE_CANDLES),
          to: candles.length,
        });
      }
    } else if (candles.length > 0) {
      series.update(toCandleData(candles[candles.length - 1]));
      volumeSeriesRef.current?.update(toVolumeData(candles[candles.length - 1]));
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

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0 }}>
      {apis && candles.length > 0 ? (
        <DrawingLayer
          chart={apis.chart}
          series={apis.series}
          store={drawingsStore}
          firstTime={candles[0].time}
          intervalSec={intervalSeconds(interval)}
        />
      ) : null}
    </div>
  );
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

function toVolumeData(candle: ChartCandle): HistogramData {
  return {
    time: candle.time as UTCTimestamp,
    value: candle.volume,
    color: candle.close >= candle.open ? 'rgba(48, 209, 88, 0.45)' : 'rgba(255, 69, 58, 0.45)',
  };
}
