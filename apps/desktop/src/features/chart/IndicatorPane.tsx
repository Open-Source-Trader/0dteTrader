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
}

/**
 * Non-interactive sub-pane (IndicatorPaneRepresentable analog): always shows
 * the full candle range (fitContent), no pan/zoom, no time axis — matching iOS.
 */
export function IndicatorPane({ height, candles, series, guideLines, yRange }: IndicatorPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<'Line' | 'Histogram'>>>(new Map());
  const yRangeRef = useRef(yRange);
  yRangeRef.current = yRange;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: 'rgba(235, 235, 245, 0.6)',
        fontSize: 9,
        fontFamily:
          "ui-monospace, 'SF Mono', 'Cascadia Mono', 'JetBrains Mono', 'DejaVu Sans Mono', Menlo, monospace",
      },
      leftPriceScale: { visible: true, borderVisible: false },
      rightPriceScale: { visible: false },
      timeScale: { visible: false },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      crosshair: {
        vertLine: { visible: false, labelVisible: false },
        horzLine: { visible: false, labelVisible: false },
      },
      handleScroll: false,
      handleScale: false,
      autoSize: true,
    });
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = new Map();
    };
  }, []);

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

        if (guideLines && spec.kind === 'line') {
          for (const level of guideLines) {
            api.createPriceLine({
              price: level,
              color: 'rgba(142, 142, 147, 0.6)',
              lineWidth: 1,
              lineStyle: 3,
              axisLabelVisible: false,
              title: '',
            });
          }
          guideLines = undefined; // Only once, on the first line series.
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
    chart.timeScale().fitContent();
  }, [candles, series, guideLines]);

  return <div ref={containerRef} style={{ height, flex: 'none', position: 'relative' }} />;
}
