import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type LineWidth,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { ChartInterval, OptionsAnalyticsSnapshot } from '@0dtetrader/shared-types';
import { useStore } from '../../core/observable';
import { Format } from '../../design/format';
import { chartPalette } from './chartColors';
import type { ChartCandle } from './ChartStore';
import { intervalSeconds } from './ChartStore';
import { DrawingLayer } from './DrawingLayer';
import type { DrawingsStore } from './drawings';
import { OptionsAnalyticsOverlay } from './optionsAnalytics/OptionsAnalyticsOverlay';
import type { OptionsAnalyticsSettings } from './optionsAnalytics/optionsAnalyticsSettings';
import { TwcOverlay } from './TwcOverlay';
import type { TwcRenderModel } from './twc/twcTypes';

export interface OverlaySeries {
  id: string;
  color: string;
  values: (number | null)[];
  /** 1..4 (lightweight-charts LineWidth); defaults to 1. */
  lineWidth?: number;
  /** Break the line at nulls (Pine linebr) instead of bridging across them. */
  gaps?: boolean;
}

interface CandleChartProps {
  candles: ChartCandle[];
  overlays: OverlaySeries[];
  symbol: string;
  interval: ChartInterval;
  showVolume: boolean;
  drawingsStore: DrawingsStore;
  /** Per-bar candle repaint colors (TWC regime candles); null = default. */
  candleColors?: (string | null)[] | null;
  /** TWC Heatmap render model for the read-only overlay canvas. */
  twcModel?: TwcRenderModel | null;
  /** Exact point-in-time options structure for the right-edge profile rail. */
  optionsAnalyticsSnapshot?: OptionsAnalyticsSnapshot | null;
  optionsAnalyticsSettings?: OptionsAnalyticsSettings | null;
  optionsAnalyticsRetained?: boolean;
}

const VISIBLE_CANDLES = 120;

function formatTick(timeSeconds: number, interval: ChartInterval): string {
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
  symbol,
  interval,
  showVolume,
  drawingsStore,
  candleColors = null,
  twcModel = null,
  optionsAnalyticsSnapshot = null,
  optionsAnalyticsSettings = null,
  optionsAnalyticsRetained = false,
}: CandleChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const overlaySeriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const lastLengthRef = useRef(0);
  const lastFirstTimeRef = useRef<number | null>(null);
  const lastBarRef = useRef<ChartCandle | null>(null);
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
    const colors = chartPalette();
    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        attributionLogo: false,
        textColor: colors.axisLabel,
        fontSize: 11,
        fontFamily:
          "'JetBrains Mono', ui-monospace, 'SF Mono', 'Cascadia Mono', 'DejaVu Sans Mono', Menlo, monospace",
      },
      leftPriceScale: { visible: true, borderColor: colors.border },
      rightPriceScale: { visible: false },
      timeScale: {
        borderColor: colors.border,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: UTCTimestamp) => formatTick(time, intervalRef.current),
        rightOffset: 12,
        shiftVisibleRangeOnNewBar: true,
      },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
      crosshair: {
        vertLine: {
          visible: true,
          labelVisible: true,
          color: colors.crosshair,
          style: 3,
          width: 1,
        },
        horzLine: {
          visible: true,
          labelVisible: true,
          color: colors.crosshair,
          style: 3,
          width: 1,
        },
      },
      autoSize: true,
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: colors.candleUp,
      downColor: colors.candleDown,
      wickUpColor: colors.candleUp,
      wickDownColor: colors.candleDown,
      borderUpColor: colors.candleUp,
      borderDownColor: colors.candleDown,
      priceScaleId: 'left',
      // Dashed accent line at the last price + axis tag (mockup's glowing
      // price tag; canvas-drawn, so a bright tag stands in for true glow).
      priceLineVisible: true,
      priceLineColor: colors.accent,
      priceLineStyle: 2,
      priceLineWidth: 1,
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
      lastBarRef.current = null;
      setApis(null);
    };
  }, []);

  // Volume histogram on its own compressed scale (bottom 20% of the pane).
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (showVolume && !volumeSeriesRef.current) {
      const series = chart.addSeries(HistogramSeries, {
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
  // Regime-candle repaints (candleColors) always reset the full data set —
  // per-bar colors can change across the whole array on any recompute.
  const hadCandleColorsRef = useRef(false);
  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    if (!chart || !series) return;

    const firstTime = candles.length > 0 ? candles[0].time : null;
    const structuralChange =
      candles.length !== lastLengthRef.current || firstTime !== lastFirstTimeRef.current;
    const repaintAll = candleColors !== null || hadCandleColorsRef.current;
    hadCandleColorsRef.current = candleColors !== null;

    if (structuralChange || repaintAll) {
      series.setData(
        candles.map((candle, index) => toCandleData(candle, candleColors?.[index] ?? null)),
      );
      volumeSeriesRef.current?.setData(candles.map(toVolumeData));
      if (structuralChange && candles.length > 0) {
        chart.timeScale().setVisibleLogicalRange({
          from: Math.max(0, candles.length - VISIBLE_CANDLES),
          to: candles.length + 12,
        });
      }
    } else if (candles.length > 0) {
      series.update(toCandleData(candles[candles.length - 1], null));
      volumeSeriesRef.current?.update(toVolumeData(candles[candles.length - 1]));
    }
    lastLengthRef.current = candles.length;
    lastFirstTimeRef.current = firstTime;
    lastBarRef.current = candles.length > 0 ? candles[candles.length - 1] : null;
  }, [candles, candleColors]);

  // Overlay lines: recreate the series set when ids change, reset data otherwise.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const existing = overlaySeriesRef.current;

    // Gap-aware overlays (Pine linebr, e.g. the TWC supertrend split by
    // direction) are expanded into ONE SERIES PER CONTIGUOUS RUN. A single
    // lightweight-charts line series connects straight across missing
    // points, which would bridge a supertrend's bull segments over bearish
    // stretches with long diagonals instead of breaking the line.
    interface ExpandedOverlay {
      id: string;
      color: string;
      lineWidth: LineWidth;
      data: LineData[];
    }
    const expanded: ExpandedOverlay[] = [];
    for (const overlay of overlays) {
      const lineWidth = (overlay.lineWidth ?? 1) as LineWidth;
      if (!overlay.gaps) {
        const data: LineData[] = [];
        overlay.values.forEach((value, index) => {
          const candle = candles[index];
          if (value !== null && candle) {
            data.push({ time: candle.time as UTCTimestamp, value });
          }
        });
        expanded.push({ id: overlay.id, color: overlay.color, lineWidth, data });
        continue;
      }
      let run: LineData[] = [];
      let runIndex = 0;
      const flushRun = (): void => {
        if (run.length > 0) {
          expanded.push({
            id: `${overlay.id}#${runIndex}`,
            color: overlay.color,
            lineWidth,
            data: run,
          });
          runIndex += 1;
          run = [];
        }
      };
      overlay.values.forEach((value, index) => {
        const candle = candles[index];
        if (!candle) return;
        if (value === null) flushRun();
        else run.push({ time: candle.time as UTCTimestamp, value });
      });
      flushRun();
    }

    const wanted = new Set(expanded.map((entry) => entry.id));
    for (const [id, series] of existing) {
      if (!wanted.has(id)) {
        chart.removeSeries(series);
        existing.delete(id);
      }
    }
    for (const entry of expanded) {
      let series = existing.get(entry.id);
      if (!series) {
        series = chart.addSeries(LineSeries, {
          color: entry.color,
          lineWidth: entry.lineWidth,
          priceScaleId: 'left',
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        existing.set(entry.id, series);
      } else {
        series.applyOptions({ color: entry.color, lineWidth: entry.lineWidth });
      }
      series.setData(entry.data);
    }
  }, [candles, overlays]);

  const resetView = () => {
    const chart = chartRef.current;
    if (!chart || candles.length === 0) return;
    // A manual price-axis drag disables auto-fit; reset restores it.
    chart.priceScale('left').applyOptions({ autoScale: true });
    chart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, candles.length - VISIBLE_CANDLES),
      to: candles.length + 12,
    });
  };

  const lastBar = candles.length > 0 ? candles[candles.length - 1] : null;

  return (
    <div
      ref={containerRef}
      // 4px top inset keeps the topmost price label clear of the card edge.
      style={{ position: 'absolute', inset: '4px 0 0 0' }}
      role="img"
      aria-label={
        lastBar
          ? `${symbol} ${interval} candlestick chart, last close ${Format.price(lastBar.close)}`
          : `${symbol} chart, no data`
      }
    >
      <button
        onClick={resetView}
        aria-label="Reset chart view"
        style={{
          position: 'absolute',
          bottom: 28,
          right: 8,
          zIndex: 5,
          width: 24,
          height: 24,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px solid var(--hud-stroke-dim)',
          borderRadius: 4,
          background: 'var(--app-surface)',
          color: 'var(--label-secondary)',
          fontSize: 11,
          fontWeight: 600,
          fontFamily: 'var(--font-mono)',
          cursor: 'pointer',
          opacity: 0.7,
        }}
      >
        A
      </button>
      {apis && candles.length > 0 && twcModel ? (
        <TwcOverlay chart={apis.chart} series={apis.series} model={twcModel} candles={candles} />
      ) : null}
      {apis && candles.length > 0 && optionsAnalyticsSnapshot && optionsAnalyticsSettings ? (
        <OptionsAnalyticsOverlay
          chart={apis.chart}
          series={apis.series}
          snapshot={optionsAnalyticsSnapshot}
          settings={optionsAnalyticsSettings}
          candles={candles}
          retained={optionsAnalyticsRetained}
        />
      ) : null}
      {apis && candles.length > 0 ? (
        <DrawingLayer
          chart={apis.chart}
          series={apis.series}
          store={drawingsStore}
          candles={candles}
          intervalSec={intervalSeconds(interval)}
        />
      ) : null}
    </div>
  );
}

function toCandleData(candle: ChartCandle, color: string | null = null): CandlestickData {
  const base: CandlestickData = {
    time: candle.time as UTCTimestamp,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  };
  if (color !== null) {
    base.color = color;
    base.borderColor = color;
    base.wickColor = color;
  }
  return base;
}

function toVolumeData(candle: ChartCandle): HistogramData {
  const colors = chartPalette();
  return {
    time: candle.time as UTCTimestamp,
    value: candle.volume,
    color: candle.close >= candle.open ? colors.volumeUp : colors.volumeDown,
  };
}
