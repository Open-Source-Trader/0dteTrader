import { useCallback, useEffect, useMemo } from 'react';
import { timed } from '../../core/timing';
import type { ChartInterval, TradingMode } from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { useStore } from '../../core/observable';
import { Menu } from '../../design/components/Menu';
import { Spinner } from '../../design/components/Spinner';
import { Format } from '../../design/format';
import { ChevronDownIcon, SlidersIcon, WarningFillIcon } from '../../design/icons';
import type { ChartStore } from './ChartStore';
import { CHART_INTERVALS, INTERVAL_HINTS } from './ChartStore';
import { CandleChart, type ChartTradingProps, type OverlaySeries } from './CandleChart';
import { overlayPalette, panePalette } from './chartColors';
import { DrawToolsMenu, DrawToolsRail } from './DrawingToolbar';
import type { DrawingsStore } from './drawings';
import { IndicatorPane, type PaneSeries } from './IndicatorPane';
import { PaneCard, type PaneReadout } from './PaneCard';
import * as engine from './indicatorEngine';
import { enabledSubPanes, type SubPaneKey } from './indicatorSettings';
import { useOptionsAnalytics } from './optionsAnalytics/useOptionsAnalytics';
import { computeTwc } from './twc/computeTwc';
import { intervalSeconds } from './ChartStore';
import './chart.css';

interface ChartViewProps {
  store: ChartStore;
  drawingsStore: DrawingsStore;
  apiClient: ApiClient;
  /** Opens the symbol-search sheet (compact header) or spotlight (desktop grid). */
  onSymbolSearch: () => void;
  /** Opens the indicator settings sheet/panel. */
  onIndicatorSettings: () => void;
  tradingMode: TradingMode;
  onToggleMode: () => void;
  /** Three clicks on the chart surface toggle the fullscreen/split layout. */
  onToggleFullscreen: () => void;
  /** Trade-ticket expiration for the exact options snapshot; null pauses shadow capture. */
  optionsAnalyticsExpiration: string | null;
  /** Desktop-grid terminal chrome: persistent left drawing-tool rail instead
   *  of a header dropdown, decluttered header. Compact/phone layout omits
   *  this and keeps its existing single-row header untouched. */
  dense?: boolean;
  /** Trading-lock flag; drives the rail's lock icon (desktop grid only). */
  positionsLocked?: boolean;
  /** Global app actions rendered at the bottom of the left drawing-tool
   *  rail (desktop grid only, when `dense`). Lock icon state reuses
   *  `positionsLocked` — same trading-lock flag, single source of truth. */
  onToggleLock?: () => void;
  onShowHistory?: () => void;
  onShowProfile?: () => void;
  onShowGexHeatmap?: () => void;
  /** Order-line overlay inputs; null when chart trading is off. */
  chartTrading: ChartTradingProps | null;
  /** Reports non-blocking analytics warnings so the screen can render them outside the canvas. */
  onOptionsAnalyticsWarning?: (message: string | null) => void;
}

// Interval hotkeys. 'H'/'D' are uppercase (shift held) so they don't collide
// with the drawing-tool hotkeys (plain v/t/r/h/b/a in DrawingLayer).
const INTERVAL_SHORTCUTS: Record<string, ChartInterval> = {
  '1': '1m',
  '5': '5m',
  '3': '15m',
  '0': '30m',
  H: '1h',
  '4': '4h',
  D: '1d',
  W: '1w',
};

// Seeded pseudo-random bar heights for the empty-chart loading skeleton.
const SKELETON_BARS = [
  42, 65, 58, 71, 49, 80, 63, 55, 74, 60, 45, 68, 77, 52, 66, 58, 70, 48, 62, 75, 56, 67, 50, 72,
];

/** Chart surface: header, candle chart with overlays and drawing tools, sub-panes. */
export function ChartView({
  store,
  drawingsStore,
  apiClient,
  onSymbolSearch,
  onIndicatorSettings,
  tradingMode,
  onToggleMode,
  onToggleFullscreen,
  optionsAnalyticsExpiration,
  dense = false,
  positionsLocked = false,
  onToggleLock,
  onShowHistory,
  onShowProfile,
  onShowGexHeatmap,
  chartTrading,
  onOptionsAnalyticsWarning,
}: ChartViewProps) {
  const {
    symbol,
    interval,
    candles,
    quote,
    isLoading,
    errorMessage,
    isStale,
    tickProgress,
    indicatorSettings,
    twcSettings,
    optionsAnalytics,
    revealPrice,
  } = useStore(store);

  // Stable: the reporting effect in CandleChart re-subscribes when this
  // changes, and it must not do that on every render.
  const onVisiblePriceRange = useCallback(
    (range: { min: number; max: number } | null) => store.setVisiblePriceRange(range),
    [store],
  );

  const optionsAnalyticsState = useOptionsAnalytics(
    apiClient,
    symbol,
    optionsAnalyticsExpiration,
    optionsAnalytics,
  );
  const optionsAnalyticsSnapshot =
    optionsAnalyticsState.snapshot &&
    optionsAnalyticsExpiration !== null &&
    optionsAnalyticsState.snapshot.scope.symbol === symbol &&
    optionsAnalyticsState.snapshot.scope.expiration === optionsAnalyticsExpiration
      ? optionsAnalyticsState.snapshot
      : null;

  const closes = useMemo(() => candles.map((c) => c.close), [candles]);

  const overlays = useMemo<OverlaySeries[]>(
    () =>
      timed('ChartView.overlays', () => {
        const colors = overlayPalette();
        const result: OverlaySeries[] = [];
        if (indicatorSettings.smaEnabled) {
          result.push({
            id: 'sma',
            color: colors.sma,
            values: engine.sma(closes, indicatorSettings.smaPeriod),
          });
        }
        if (indicatorSettings.emaEnabled) {
          result.push({
            id: 'ema',
            color: colors.ema,
            values: engine.ema(closes, indicatorSettings.emaPeriod),
          });
        }
        if (indicatorSettings.vwapEnabled) {
          result.push({ id: 'vwap', color: colors.vwap, values: engine.vwap(candles) });
        }
        if (indicatorSettings.bollingerEnabled) {
          const bands = engine.bollingerBands(
            candles,
            indicatorSettings.bollingerPeriod,
            indicatorSettings.bollingerMultiplier,
          );
          result.push({
            id: 'bollingerUpper',
            color: colors.bollingerUpper,
            values: bands.upper,
          });
          result.push({
            id: 'bollingerMiddle',
            color: colors.bollingerMiddle,
            values: bands.middle,
          });
          result.push({
            id: 'bollingerLower',
            color: colors.bollingerLower,
            values: bands.lower,
          });
        }
        return result;
      }),
    [candles, closes, indicatorSettings],
  );

  const twcModel = useMemo(
    () =>
      timed('ChartView.twcModel', () =>
        computeTwc(candles, twcSettings, intervalSeconds(interval)),
      ),
    [candles, twcSettings, interval],
  );

  const globalWarningText =
    optionsAnalytics.enabled && optionsAnalyticsState.errorMessage
      ? `Options analytics unavailable: ${optionsAnalyticsState.errorMessage}`
      : (twcModel?.banner?.text ?? null);

  useEffect(() => {
    onOptionsAnalyticsWarning?.(globalWarningText);
  }, [onOptionsAnalyticsWarning, globalWarningText]);

  // TWC line series ride the price scale like regular overlays (gap-aware).
  const twcLineOverlays = useMemo<OverlaySeries[]>(
    () =>
      (twcModel?.lines ?? []).map((line) => ({
        id: `twc-${line.id}`,
        color: line.color,
        values: line.values,
        lineWidth: line.lineWidth,
        gaps: true,
      })),
    [twcModel],
  );

  const rsiSeries = useMemo<PaneSeries[] | null>(
    () =>
      timed('ChartView.rsiSeries', () => {
        if (!indicatorSettings.rsiEnabled) return null;
        return [
          {
            id: 'rsi',
            kind: 'line' as const,
            color: panePalette().rsi,
            values: engine.rsi(candles, indicatorSettings.rsiPeriod),
          },
        ];
      }),
    [candles, indicatorSettings.rsiEnabled, indicatorSettings.rsiPeriod],
  );

  // Sub-panes are capped (MAX_SUB_PANES); only panes inside the cap render.
  const visiblePanes = useMemo<Set<SubPaneKey>>(
    () => new Set(enabledSubPanes(indicatorSettings)),
    [indicatorSettings],
  );

  const macdSeries = useMemo<PaneSeries[] | null>(
    () =>
      timed('ChartView.macdSeries', () => {
        if (!indicatorSettings.macdEnabled) return null;
        const values = engine.macd(
          candles,
          indicatorSettings.macdFastPeriod,
          indicatorSettings.macdSlowPeriod,
          indicatorSettings.macdSignalPeriod,
        );
        const colors = panePalette();
        return [
          {
            id: 'macdHistogram',
            kind: 'histogram' as const,
            positiveColor: colors.macdPositive,
            negativeColor: colors.macdNegative,
            values: values.histogram,
          },
          { id: 'macd', kind: 'line' as const, color: colors.macd, values: values.macdLine },
          {
            id: 'macdSignal',
            kind: 'line' as const,
            color: colors.macdSignal,
            values: values.signalLine,
          },
        ];
      }),
    [
      candles,
      indicatorSettings.macdEnabled,
      indicatorSettings.macdFastPeriod,
      indicatorSettings.macdSlowPeriod,
      indicatorSettings.macdSignalPeriod,
    ],
  );

  const stochSeries = useMemo<PaneSeries[] | null>(
    () =>
      timed('ChartView.stochSeries', () => {
        if (!indicatorSettings.stochEnabled) return null;
        const values = engine.stochastic(
          candles,
          indicatorSettings.stochKPeriod,
          indicatorSettings.stochKSmooth,
          indicatorSettings.stochDPeriod,
        );
        const colors = panePalette();
        return [
          { id: 'stochK', kind: 'line' as const, color: colors.stochK, values: values.k },
          { id: 'stochD', kind: 'line' as const, color: colors.stochD, values: values.d },
        ];
      }),
    [
      candles,
      indicatorSettings.stochEnabled,
      indicatorSettings.stochKPeriod,
      indicatorSettings.stochKSmooth,
      indicatorSettings.stochDPeriod,
    ],
  );

  const atrSeries = useMemo<PaneSeries[] | null>(
    () =>
      timed('ChartView.atrSeries', () => {
        if (!indicatorSettings.atrEnabled) return null;
        return [
          {
            id: 'atr',
            kind: 'line' as const,
            color: panePalette().atr,
            values: engine.atr(candles, indicatorSettings.atrPeriod),
          },
        ];
      }),
    [candles, indicatorSettings.atrEnabled, indicatorSettings.atrPeriod],
  );

  // Interval hotkeys (1/5/3/⇧H/⇧D); ignored while typing in a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const shortcut = INTERVAL_SHORTCUTS[event.key];
      if (shortcut) store.selectInterval(shortcut);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  return (
    <section
      className={dense ? 'chart-shell chart-shell--desktop' : 'chart-shell'}
      aria-label="Chart shell"
    >
      <div className="chart-command-bar" data-chart-toolbar="true">
        <button
          className="chart-header-symbol chart-command-bar__symbol"
          onClick={onSymbolSearch}
          aria-label={`Symbol ${symbol}. Change symbol`}
        >
          <span className="chart-header-symbol-text">{symbol}</span>
          <span aria-hidden="true" className="chart-command-bar__chevron">
            <ChevronDownIcon size={12} />
          </span>
        </button>

        {quote ? (
          <div className="chart-command-bar__quote numeric">
            <span>{Format.price(quote.last)}</span>
            <span className="chart-command-bar__quote-secondary">
              Bid {Format.price(quote.bid)} · Ask {Format.price(quote.ask)}
            </span>
            {isStale ? <span className="chart-command-bar__stale">STALE</span> : null}
          </div>
        ) : null}

        <div className="chart-command-bar__actions">
          {tickProgress ? (
            <span
              className="quick-chip chart-command-bar__secondary"
              aria-label={`Building candle: ${tickProgress.count} of ${tickProgress.size} ticks`}
            >
              {tickProgress.count}/{tickProgress.size} ticks
            </span>
          ) : null}
          <button
            className={tradingMode === 'live' ? 'hud-badge hud-badge--live' : 'hud-badge'}
            onClick={onToggleMode}
            aria-label={`Trading mode ${tradingMode === 'live' ? 'LIVE TRADING' : 'PRACTICE'}. Switch mode`}
          >
            {/* This badge is brokerage account mode (real money vs. paper),
                never market-data liveness — the AI Trade Desk header has its
                own, separate LIVE/DELAYED/MARKET CLOSED label for that. The
                bare word "LIVE" here previously read as a market-data claim
                sitting right next to "MARKET CLOSED" in the Trade Desk band;
                spelling it out avoids that misreading without introducing a
                second state source. */}
            {tradingMode === 'live' ? 'LIVE TRADING' : 'PRACTICE'}
          </button>
          <Menu
            trigger={
              <button
                className="chart-command-bar__interval"
                aria-label={`Chart interval ${interval}`}
                aria-haspopup="menu"
              >
                <span className="chart-command-bar__interval-label">{interval}</span>
                <ChevronDownIcon size={11} />
              </button>
            }
            panelClassName="chart-interval-menu"
            items={CHART_INTERVALS.map((option) => ({
              key: option,
              label: (
                <>
                  {option.toUpperCase()}
                  {INTERVAL_HINTS[option] ? (
                    <span className="chart-command-bar__menu-hint">{INTERVAL_HINTS[option]}</span>
                  ) : null}
                </>
              ),
              checked: option === interval,
              onSelect: () => store.selectInterval(option),
            }))}
          />
          {dense ? null : <DrawToolsMenu store={drawingsStore} />}
          <button
            className="chart-icon-button draw-rail-button chart-command-bar__indicators"
            onClick={onIndicatorSettings}
            aria-label="Indicators"
            aria-haspopup="dialog"
            title="Indicators"
          >
            <SlidersIcon size={16} />
          </button>
        </div>
      </div>

      {globalWarningText ? (
        <div
          className="desktop-warning-row chart-warning-row"
          role="status"
          title={globalWarningText}
        >
          <span className="desktop-warning-chip desktop-warning-chip--caution">
            <WarningFillIcon size={11} />
            Caution
          </span>
          <span className="chart-warning-row__message">{globalWarningText}</span>
        </div>
      ) : null}

      {/* Chart area row: the persistent drawing-tool rail (desktop grid
          only) sits flush with the chart canvas card, not the header above
          it — TradingView's left toolbar is always vertically aligned with
          the chart itself. */}
      <div className="chart-plot-area" data-chart-plot-area="true">
        {dense ? (
          <DrawToolsRail
            store={drawingsStore}
            locked={positionsLocked}
            onToggleLock={onToggleLock}
            onShowHistory={onShowHistory}
            onShowProfile={onShowProfile}
            onShowGexHeatmap={onShowGexHeatmap}
          />
        ) : null}
        <div className="chart-plot-surface">
          <div
            style={{ flex: 1, minHeight: 0, position: 'relative' }}
            onClick={(event) => {
              // Three clicks toggle fullscreen — chrome that lives on this same
              // surface (the reset button, the placement window) answers for
              // its own clicks and is excluded here.
              if (event.detail !== 3) return;
              if ((event.target as Element).closest('button, [data-chart-placement]')) return;
              onToggleFullscreen();
            }}
          >
            <CandleChart
              candles={candles}
              overlays={twcLineOverlays.length > 0 ? [...overlays, ...twcLineOverlays] : overlays}
              symbol={symbol}
              interval={interval}
              showVolume={indicatorSettings.volumeEnabled}
              drawingsStore={drawingsStore}
              candleColors={twcModel?.candleColors ?? null}
              twcModel={twcModel}
              optionsAnalyticsSnapshot={optionsAnalyticsSnapshot}
              optionsAnalyticsSettings={optionsAnalytics.enabled ? optionsAnalytics : null}
              optionsAnalyticsRetained={optionsAnalyticsState.retained}
              bid={dense ? (quote?.bid ?? null) : null}
              ask={dense ? (quote?.ask ?? null) : null}
              chartTrading={chartTrading}
              revealPrice={revealPrice}
              onVisiblePriceRange={onVisiblePriceRange}
            />
            {isLoading && candles.length === 0 && (
              <div className="chart-skeleton" aria-hidden="true">
                {SKELETON_BARS.map((height, index) => (
                  <div className="bar" key={index} style={{ height: `${height}%` }} />
                ))}
              </div>
            )}
            {isLoading && candles.length > 0 && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  pointerEvents: 'none',
                }}
              >
                <Spinner />
              </div>
            )}
            {errorMessage && candles.length === 0 ? (
              <div
                role="alert"
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 12,
                  padding: 16,
                  textAlign: 'center',
                }}
              >
                <span className="text-secondary" style={{ fontSize: 'var(--fs-footnote)' }}>
                  {errorMessage}
                </span>
                <button
                  onClick={() => void store.loadCandles()}
                  style={{
                    color: 'var(--app-accent-text)',
                    fontSize: 'var(--fs-footnote)',
                    fontWeight: 600,
                    minHeight: 44,
                    padding: '0 16px',
                  }}
                >
                  Retry
                </button>
              </div>
            ) : null}
            {errorMessage && candles.length > 0 ? (
              // Refresh failed over live candles: surface it without blocking.
              <div className="toast" role="alert">
                <div
                  className="toast-capsule"
                  style={{
                    borderColor: 'color-mix(in srgb, var(--pnl-negative) 60%, transparent)',
                  }}
                >
                  {errorMessage}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {rsiSeries && visiblePanes.has('rsiEnabled') ? (
        <PaneCard
          title={`RSI (${indicatorSettings.rsiPeriod})`}
          readouts={paneReadouts(rsiSeries, { rsi: '' })}
        >
          <IndicatorPane
            height={68}
            candles={candles}
            series={rsiSeries}
            guideLines={[30, 70]}
            yRange={[0, 100]}
          />
        </PaneCard>
      ) : null}
      {macdSeries && visiblePanes.has('macdEnabled') ? (
        <PaneCard
          title={`MACD (${indicatorSettings.macdFastPeriod}, ${indicatorSettings.macdSlowPeriod}, ${indicatorSettings.macdSignalPeriod})`}
          readouts={paneReadouts(macdSeries, {
            macd: 'MACD',
            macdSignal: 'Sig',
            macdHistogram: 'Hist',
          })}
        >
          <IndicatorPane height={72} candles={candles} series={macdSeries} />
        </PaneCard>
      ) : null}
      {stochSeries && visiblePanes.has('stochEnabled') ? (
        <PaneCard
          title={`Stoch (${indicatorSettings.stochKPeriod}, ${indicatorSettings.stochKSmooth}, ${indicatorSettings.stochDPeriod})`}
          readouts={paneReadouts(stochSeries, { stochK: '%K', stochD: '%D' })}
        >
          <IndicatorPane
            height={68}
            candles={candles}
            series={stochSeries}
            guideLines={[20, 80]}
            yRange={[0, 100]}
          />
        </PaneCard>
      ) : null}
      {atrSeries && visiblePanes.has('atrEnabled') ? (
        <PaneCard
          title={`ATR (${indicatorSettings.atrPeriod})`}
          readouts={paneReadouts(atrSeries, { atr: '' })}
        >
          <IndicatorPane height={68} candles={candles} series={atrSeries} />
        </PaneCard>
      ) : null}
    </section>
  );
}

/** Live value readouts for a pane card: last non-null of each labeled series,
 *  in label order. Histogram series get their sign color (green/red). */
function paneReadouts(series: PaneSeries[], labels: Record<string, string>): PaneReadout[] {
  const readouts: PaneReadout[] = [];
  for (const [id, label] of Object.entries(labels)) {
    const spec = series.find((candidate) => candidate.id === id);
    if (!spec) continue;
    const value = engine.lastValue(spec.values);
    if (value === null) continue;
    const color =
      spec.kind === 'histogram'
        ? ((value >= 0 ? spec.positiveColor : spec.negativeColor) ?? 'var(--label-secondary)')
        : (spec.color ?? 'var(--label-secondary)');
    readouts.push({ label, value: value.toFixed(2), color });
  }
  return readouts;
}
