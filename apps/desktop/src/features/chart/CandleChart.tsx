import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type AutoscaleInfo,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type IPriceLine,
  type IRange,
  type ISeriesApi,
  type LineData,
  type LineWidth,
  type UTCTimestamp,
} from 'lightweight-charts';
import type {
  ChartInterval,
  ChartOrder,
  OptionContract,
  OptionsAnalyticsSnapshot,
  ChartOrderType,
  Position,
} from '@0dtetrader/shared-types';
import { useStore } from '../../core/observable';
import { Format } from '../../design/format';
import { chartPalette } from './chartColors';
import { CORNER_CONTROL_INSET, CORNER_CONTROL_RADIUS, CORNER_CONTROL_SIZE } from './cornerSeat';
import type { ChartCandle } from './ChartStore';
import { intervalSeconds } from './ChartStore';
import type { ChartOrdersStore } from './chartOrders';
import type { ChartTradingSettings } from './chartTradingSettings';
import { DrawingLayer } from './DrawingLayer';
import { FloatingAxes } from './FloatingAxes';
import type { DrawingsStore } from './drawings';
import { OrderLineLayer } from './OrderLineLayer';
import { sameColorsExceptLast } from './candleRepaint';
import { extendPriceRange } from './priceReveal';
import { OptionsAnalyticsOverlay } from './optionsAnalytics/OptionsAnalyticsOverlay';
import { optionsAnalyticsRailWidth } from './optionsAnalytics/optionsAnalyticsGeometry';
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
  /** Live underlying bid/ask (TradingView convention: bid/ask lines pinned
   *  to the price axis). Desktop grid only; null hides both lines. */
  bid?: number | null;
  ask?: number | null;
  /** Chart trading: everything the order-line overlay needs, or null when off. */
  chartTrading?: ChartTradingProps | null;
  /** Price the chart must keep in view ("Show on chart"); null = none. */
  revealPrice?: number | null;
  /** Reports the pane's visible price domain after every repaint-worthy
   *  change; null when it cannot be read (no data yet, chart torn down). */
  onVisiblePriceRange?: (range: { min: number; max: number } | null) => void;
}

/** Inputs for the order-line overlay, passed through from the trade screen. */
export interface ChartTradingProps {
  store: ChartOrdersStore;
  settings: ChartTradingSettings;
  positions: Position[];
  resolveContract: (contractSymbol: string) => OptionContract | null;
  selectedContract: OptionContract | null;
  defaultOrderType: ChartOrderType;
  onFlatten: (position: Position) => void;
  /** Confirms cancelling a working line — the desktop half of the alert iOS
   *  shows in ChartTradingCoordinator. */
  onCancelOrder: (order: ChartOrder) => void;
}

const VISIBLE_CANDLES = 120;

/**
 * Candlestick chart with indicator overlays (CandleChartRepresentable analog).
 * Both scales float over the plot like the iOS chart; pan/zoom enabled. On a
 * data-length change the view snaps to the last 120 bars; in-place tick updates
 * leave the user's pan/zoom alone.
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
  bid = null,
  ask = null,
  chartTrading = null,
  revealPrice = null,
  onVisiblePriceRange,
}: CandleChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  /** Read by the autoscale provider, which is bound once at series creation. */
  const revealPriceRef = useRef<number | null>(null);
  /** Manual price range to put back when a reveal clears — only set when the
   *  reveal found the scale in manual mode (see the reveal effect below). */
  const revealRestoreRef = useRef<IRange<number> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const bidLineRef = useRef<IPriceLine | null>(null);
  const askLineRef = useRef<IPriceLine | null>(null);
  const overlaySeriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const prevOverlaysRef = useRef<{
    ids: string[];
    lengths: number[];
    firstTime: number | null;
  } | null>(null);
  const lastLengthRef = useRef(0);
  const lastFirstTimeRef = useRef<number | null>(null);
  const lastBarRef = useRef<ChartCandle | null>(null);
  const prevSymbolRef = useRef(symbol);
  const [apis, setApis] = useState<{
    chart: IChartApi;
    series: ISeriesApi<'Candlestick'>;
  } | null>(null);
  const { draft } = useStore(drawingsStore);

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
      // Both scales are hidden and `FloatingAxes` draws them over the candles
      // instead: lightweight-charts has no inside-label mode, and a visible
      // scale reserves a strip of the card no matter how it is styled. The
      // grid goes with them, because the library only exposes its tick marks
      // by drawing them — the labels and the lines have to come from one place
      // or they disagree.
      leftPriceScale: { visible: false },
      rightPriceScale: { visible: false },
      timeScale: {
        visible: false,
        rightOffset: 12,
        shiftVisibleRangeOnNewBar: true,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false },
      },
      crosshair: {
        vertLine: {
          visible: true,
          // Same reason as the last-price tag: crosshair labels print on the
          // scales, and there are no scales to print on.
          labelVisible: false,
          color: colors.crosshair,
          style: 3,
          width: 1,
        },
        horzLine: {
          visible: true,
          labelVisible: false,
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
      // Dashed accent line at the last price, matching the iOS limit line.
      // The tag that used to ride it is off: a scale-drawn label has nowhere
      // to print now that the scales are hidden, so it would just vanish.
      priceLineVisible: true,
      priceLineColor: colors.accent,
      priceLineStyle: 2,
      priceLineWidth: 1,
      lastValueVisible: false,
      // "Show on chart": while a reveal is set, the auto range is widened to
      // include it — lightweight-charts has no price-axis scroll API, so
      // extending what autoscale computes is the sanctioned route to a level
      // outside the data's own range. Null reveal returns the base range
      // untouched, which is what restores the viewport on clear.
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null): AutoscaleInfo | null => {
        const info = original();
        const reveal = revealPriceRef.current;
        if (reveal === null || info === null || info.priceRange === null) return info;
        const range = extendPriceRange(info.priceRange.minValue, info.priceRange.maxValue, reveal);
        return { ...info, priceRange: { minValue: range.min, maxValue: range.max } };
      },
    });
    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    setApis({ chart, series: candleSeries });

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      bidLineRef.current = null;
      askLineRef.current = null;
      revealRestoreRef.current = null;
      overlaySeriesRef.current = new Map();
      prevOverlaysRef.current = null;
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

  // Live underlying bid/ask price lines pinned to the axis (TradingView
  // convention) — desktop grid only; null bid/ask (compact layout, no
  // quote yet) removes the lines rather than leaving stale ones behind.
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    const colors = chartPalette();

    if (bid !== null) {
      if (!bidLineRef.current) {
        bidLineRef.current = series.createPriceLine({
          price: bid,
          color: colors.candleUp,
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: 'BID',
        });
      } else {
        bidLineRef.current.applyOptions({ price: bid });
      }
    } else if (bidLineRef.current) {
      series.removePriceLine(bidLineRef.current);
      bidLineRef.current = null;
    }

    if (ask !== null) {
      if (!askLineRef.current) {
        askLineRef.current = series.createPriceLine({
          price: ask,
          color: colors.candleDown,
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: 'ASK',
        });
      } else {
        askLineRef.current.applyOptions({ price: ask });
      }
    } else if (askLineRef.current) {
      series.removePriceLine(askLineRef.current);
      askLineRef.current = null;
    }
  }, [bid, ask]);

  // "Show on chart" reveal. Autoscaling scale (the default here): the provider
  // above merges the level into the auto range, and re-applying
  // `autoScale: true` — the same nudge resetView and the symbol swap use —
  // makes the merge take effect now rather than on the next data tick;
  // clearing recomputes without the level, which *is* the restoration. Manual
  // scale (after a FloatingAxes axis drag): the provider never runs, so the
  // visible range itself is extended and the pre-reveal range put back on
  // clear. A drag *during* a reveal wins over both paths — the scale it
  // leaves behind is the user's newest intent, and neither branch below
  // touches a manual scale it did not itself extend.
  useEffect(() => {
    revealPriceRef.current = revealPrice;
    const chart = chartRef.current;
    if (!chart) return;
    const scale = chart.priceScale('left');
    if (revealPrice !== null) {
      if (scale.options().autoScale) {
        revealRestoreRef.current = null;
        scale.applyOptions({ autoScale: true });
      } else {
        const current = scale.getVisibleRange();
        if (current === null) return;
        revealRestoreRef.current ??= current;
        const extended = extendPriceRange(current.from, current.to, revealPrice);
        scale.setVisibleRange({ from: extended.min, to: extended.max });
      }
    } else {
      const restore = revealRestoreRef.current;
      revealRestoreRef.current = null;
      if (restore !== null && !scale.options().autoScale) scale.setVisibleRange(restore);
      else if (scale.options().autoScale) scale.applyOptions({ autoScale: true });
    }
  }, [revealPrice]);

  // Reports the pane's visible price domain (the workspace's "Show on chart"
  // affordance needs to know when an order line sits outside it). Same
  // repaint triggers FloatingAxes uses for the transform they both read, plus
  // crosshair moves so an axis drag — which changes no logical range — still
  // reports. ChartStore drops sub-epsilon updates, so live autoscale jitter
  // does not fan out into re-renders.
  const reportRangeRef = useRef<() => void>(() => {});
  useEffect(() => {
    const container = containerRef.current;
    if (!apis || !onVisiblePriceRange || !container) return;
    let raf = 0;
    const report = () => {
      raf = 0;
      const max = apis.series.coordinateToPrice(0);
      const min = apis.series.coordinateToPrice(apis.chart.paneSize().height);
      onVisiblePriceRange(min !== null && max !== null ? { min, max } : null);
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(report);
    };
    reportRangeRef.current = schedule;
    apis.chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
    apis.chart.subscribeCrosshairMove(schedule);
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(container);
    schedule();
    return () => {
      reportRangeRef.current = () => {};
      apis.chart.timeScale().unsubscribeVisibleLogicalRangeChange(schedule);
      apis.chart.unsubscribeCrosshairMove(schedule);
      resizeObserver.disconnect();
      if (raf) cancelAnimationFrame(raf);
      // The domain this reported no longer exists; a stale range would keep
      // offering "Show on chart" against nothing.
      onVisiblePriceRange(null);
    };
  }, [apis, onVisiblePriceRange]);

  // Candle data and the reveal both move the price↔pixel transform under the
  // reported range.
  useEffect(() => {
    reportRangeRef.current();
  }, [candles, revealPrice]);

  // A drag-placed shape (trend/ray/rect) takes over the pointer mid-drag:
  // freeze pan/zoom so the chart doesn't scroll under the draft. Tools stay
  // armed after a placement (see drawings.ts), so gating on `tool` alone
  // would leave pan/zoom disabled long after the drag ends; DrawingLayer's
  // own canvas already blocks stray presses whenever a tool is armed.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const interactive = draft === null;
    chart.applyOptions({ handleScroll: interactive, handleScale: interactive });
  }, [draft]);

  // Candle data: cheap update on ticks and on each new bar, full set only on a
  // genuine structural replacement. A NEW CANDLE starting (length grows, head
  // time unchanged) is NOT structural: we `series.update()` the last bar and
  // let `shiftVisibleRangeOnNewBar` scroll it into view while the user's
  // pan/zoom is left untouched. The whole set is only repainted on the first
  // load, when the sliding window drops the oldest bar (head time changes), or
  // when a PAST bar's regime color actually changed.
  const lastCandleColorsRef = useRef<(string | null)[] | null>(null);
  useEffect(() => {
    if (prevSymbolRef.current === symbol) return;
    prevSymbolRef.current = symbol;
    const chart = chartRef.current;
    if (!chart) return;
    // A symbol swap should behave like a fresh chart session: clear the
    // cached history so the next dataset recenters instead of reusing the
    // previous symbol's viewport and price scale.
    chart.priceScale('left').applyOptions({ autoScale: true });
    lastLengthRef.current = 0;
    lastFirstTimeRef.current = null;
    lastCandleColorsRef.current = null;
    prevOverlaysRef.current = null;
  }, [symbol]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    if (!chart || !series) return;

    const firstTime = candles.length > 0 ? candles[0].time : null;
    const hadData = lastLengthRef.current > 0;
    const isFirstLoad = !hadData && candles.length > 0;
    const headChanged = firstTime !== lastFirstTimeRef.current;
    const truncated = headChanged && hadData;
    // A regime-color toggle (off→on, on→off) must repaint everything.
    const colorsToggled = (candleColors !== null) !== (lastCandleColorsRef.current !== null);
    // Past-bar colors only: the forming (last) bar's color is applied via
    // update(), so a change there alone must not force a full repaint.
    const priorColorsChanged =
      candleColors !== null &&
      lastCandleColorsRef.current !== null &&
      !sameColorsExceptLast(candleColors, lastCandleColorsRef.current);
    const needFullSet = isFirstLoad || truncated || colorsToggled || priorColorsChanged;

    if (needFullSet) {
      // Preserve the current time window unless this is the very first paint
      // (then snap to the live edge so the user lands on the right).
      const prevRange = isFirstLoad ? null : chart.timeScale().getVisibleRange();
      series.setData(
        candles.map((candle, index) => toCandleData(candle, candleColors?.[index] ?? null)),
      );
      volumeSeriesRef.current?.setData(candles.map(toVolumeData));
      if (isFirstLoad && candles.length > 0) {
        chart.timeScale().setVisibleLogicalRange({
          from: Math.max(0, candles.length - VISIBLE_CANDLES),
          to: candles.length + 12,
        });
      } else if (prevRange && candles.length > 0) {
        chart.timeScale().setVisibleRange(prevRange);
      }
    } else if (candles.length > 0) {
      // In-place tick update OR a freshly started candle: update the last bar
      // (regime color included). No view reset — the user keeps their zoom.
      series.update(
        toCandleData(candles[candles.length - 1], candleColors?.[candles.length - 1] ?? null),
      );
      volumeSeriesRef.current?.update(toVolumeData(candles[candles.length - 1]));
    }
    lastLengthRef.current = candles.length;
    lastFirstTimeRef.current = firstTime;
    lastCandleColorsRef.current = candleColors;
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
    const firstTime = candles.length > 0 ? candles[0].time : null;
    const prev = prevOverlaysRef.current;
    for (const [idx, entry] of expanded.entries()) {
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
      // A structural change (series added/removed, run lengths changed, or the
      // data head moved on truncation) requires a full setData. Otherwise the
      // overlay's forming (last) point is the only thing that changed on this
      // tick, so update() it instead of rebuilding the whole series every quote.
      const structural =
        !prev ||
        entry.id !== prev.ids[idx] ||
        prev.firstTime !== firstTime ||
        entry.data.length !== prev.lengths[idx];
      if (structural) {
        series.setData(entry.data);
      } else {
        const lastPoint = entry.data[entry.data.length - 1];
        if (lastPoint) series.update(lastPoint);
      }
    }
    prevOverlaysRef.current = {
      ids: expanded.map((entry) => entry.id),
      lengths: expanded.map((entry) => entry.data.length),
      firstTime,
    };
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
      // 4px top inset keeps the topmost price label clear of the card edge;
      // 6px on the left does the same for the first digit of every price
      // label, which lightweight-charts otherwise draws hard against it.
      style={{ position: 'absolute', inset: '4px 0 0 6px' }}
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
        // Seated in the card's bottom-right corner cut rather than parked above
        // the time axis, with the seat derived in `cornerSeat` — the same
        // module the placement guide's `+` measures from, which is what puts
        // the two in one column.
        style={{
          position: 'absolute',
          bottom: CORNER_CONTROL_INSET,
          right: CORNER_CONTROL_INSET,
          zIndex: 5,
          width: CORNER_CONTROL_SIZE,
          height: CORNER_CONTROL_SIZE,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px solid var(--hud-stroke-dim)',
          borderRadius: CORNER_CONTROL_RADIUS,
          background: 'var(--app-surface)',
          color: 'var(--label-secondary)',
          fontSize: 11,
          fontWeight: 600,
          fontFamily: 'var(--font-mono)',
          cursor: 'pointer',
        }}
      >
        A
      </button>
      {apis && candles.length > 0 ? (
        <FloatingAxes
          chart={apis.chart}
          series={apis.series}
          candles={candles}
          interval={interval}
        />
      ) : null}
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
      {apis && candles.length > 0 && chartTrading?.settings.enabled ? (
        <OrderLineLayer
          chart={apis.chart}
          series={apis.series}
          store={chartTrading.store}
          settings={chartTrading.settings}
          symbol={symbol}
          positions={chartTrading.positions}
          resolveContract={chartTrading.resolveContract}
          selectedContract={chartTrading.selectedContract}
          defaultOrderType={chartTrading.defaultOrderType}
          onFlatten={chartTrading.onFlatten}
          onCancelOrder={chartTrading.onCancelOrder}
          candles={candles}
          // Keep the button rows and the `+` clear of the analytics rail —
          // guarded on the same condition the rail itself renders under, since
          // a cached snapshot outlives the setting being switched off.
          rightInset={
            optionsAnalyticsSnapshot && optionsAnalyticsSettings
              ? optionsAnalyticsRailWidth(apis.chart.paneSize().width)
              : 0
          }
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
