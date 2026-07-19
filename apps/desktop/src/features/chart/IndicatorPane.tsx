import { useEffect, useRef } from 'react';
import {
  ColorType,
  createChart,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from 'lightweight-charts';
import { chartPalette } from './chartColors';
import type { VisibleRange } from './CandleChart';
import type { ChartCandle } from './ChartStore';

export interface PaneSeries {
  id: string;
  kind: 'line' | 'histogram';
  color?: string;
  /** Histogram colors per sign (MACD). */
  positiveColor?: string;
  negativeColor?: string;
  values: (number | null)[];
}

interface IndicatorPaneProps {
  height: number;
  candles: ChartCandle[];
  series: PaneSeries[];
  /** Dashed horizontal guide lines (RSI 30/70). */
  guideLines?: number[];
  /** Fixed y range (RSI 0–100). */
  yRange?: [number, number];
  /** Main chart's visible x-range; keeps the pane aligned while panning. */
  visibleRange?: VisibleRange | null;
  /** Called when the user zooms/pans this pane directly. */
  onVisibleRangeChange?: (range: VisibleRange) => void;
}

/**
 * Sub-pane for indicators (RSI, MACD, etc.). Mirrors the main chart's visible
 * x-range and also allows independent zoom/pan, broadcasting changes back.
 */
export function IndicatorPane({
  height,
  candles,
  series,
  guideLines,
  yRange,
  visibleRange,
  onVisibleRangeChange,
}: IndicatorPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onVisibleRangeChangeRef = useRef(onVisibleRangeChange);
  onVisibleRangeChangeRef.current = onVisibleRangeChange;
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<'Line' | 'Histogram'>>>(new Map());
  const yRangeRef = useRef(yRange);
  yRangeRef.current = yRange;
  const guideLinesRef = useRef(guideLines);
  guideLinesRef.current = guideLines;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const colors = chartPalette();
    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        attributionLogo: false,
        textColor: colors.axisLabel,
        fontSize: 10,
        fontFamily:
          "'JetBrains Mono', ui-monospace, 'SF Mono', 'Cascadia Mono', 'DejaVu Sans Mono', Menlo, monospace",
      },
      leftPriceScale: { visible: true, borderVisible: false },
      rightPriceScale: { visible: false },
      timeScale: { visible: false },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      crosshair: {
        vertLine: { visible: false, labelVisible: false },
        horzLine: { visible: false, labelVisible: false },
      },
      handleScroll: true,
      handleScale: true,
      autoSize: true,
    });
    chartRef.current = chart;

    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range) onVisibleRangeChangeRef.current?.({ from: range.from, to: range.to });
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = new Map();
    };
  }, []);

  // Data + series lifecycle: runs only when the data actually changes.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const existing = seriesRef.current;
    const wanted = new Set(series.map((s) => s.id));

    for (const [id, api] of existing) {
      if (!wanted.has(id)) {
        chart.removeSeries(api);
        existing.delete(id);
      }
    }

    const fixedRange = yRangeRef.current;
    const guideColor = chartPalette().guide;
    let guidesDrawn = false;
    for (const spec of series) {
      let api = existing.get(spec.id);
      if (!api) {
        const common = {
          priceScaleId: 'left',
          priceLineVisible: false,
          lastValueVisible: false,
          autoscaleInfoProvider: fixedRange
            ? () => ({ priceRange: { minValue: fixedRange[0], maxValue: fixedRange[1] } })
            : undefined,
        };
        api =
          spec.kind === 'histogram'
            ? chart.addHistogramSeries({ ...common, base: 0 })
            : chart.addLineSeries({
                ...common,
                color: spec.color,
                lineWidth: 1,
                crosshairMarkerVisible: false,
              });
        existing.set(spec.id, api);

        const guides = guideLinesRef.current;
        if (!guidesDrawn && guides && spec.kind === 'line') {
          for (const level of guides) {
            api.createPriceLine({
              price: level,
              color: guideColor,
              lineWidth: 1,
              lineStyle: 3,
              axisLabelVisible: false,
              title: '',
            });
          }
          guidesDrawn = true;
        }
      }

      if (spec.kind === 'histogram') {
        const data: HistogramData[] = [];
        spec.values.forEach((value, index) => {
          const candle = candles[index];
          if (value !== null && candle) {
            data.push({
              time: candle.time as UTCTimestamp,
              value,
              color: value >= 0 ? spec.positiveColor : spec.negativeColor,
            });
          }
        });
        (api as ISeriesApi<'Histogram'>).setData(data);
      } else {
        const data: LineData[] = [];
        spec.values.forEach((value, index) => {
          const candle = candles[index];
          if (value !== null && candle) {
            data.push({ time: candle.time as UTCTimestamp, value });
          }
        });
        (api as ISeriesApi<'Line'>).setData(data);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, series]);

  // View sync: cheap range application while the user pans the main chart.
  // Guard against feedback loops from bidirectional sync.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (visibleRange) {
      const current = chart.timeScale().getVisibleLogicalRange();
      if (
        current &&
        Math.abs(current.from - visibleRange.from) < 0.5 &&
        Math.abs(current.to - visibleRange.to) < 0.5
      )
        return;
      chart.timeScale().setVisibleLogicalRange(visibleRange);
    } else {
      chart.timeScale().fitContent();
    }
  }, [visibleRange]);

  const resetView = () => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.timeScale().fitContent();
  };

  return (
    <div style={{ height, flex: 'none', position: 'relative' }}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      <button
        onClick={resetView}
        aria-label="Reset pane view"
        style={{
          position: 'absolute',
          bottom: 4,
          right: 8,
          zIndex: 5,
          width: 20,
          height: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px solid var(--hud-stroke-dim)',
          borderRadius: 3,
          background: 'var(--app-surface)',
          color: 'var(--label-secondary)',
          fontSize: 9,
          fontWeight: 600,
          fontFamily: 'var(--font-mono)',
          cursor: 'pointer',
          opacity: 0.7,
        }}
      >
        A
      </button>
    </div>
  );
}
