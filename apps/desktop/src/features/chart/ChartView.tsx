import { useEffect, useMemo } from 'react';
import type { ChartInterval, TradingMode } from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { useStore } from '../../core/observable';
import { Menu } from '../../design/components/Menu';
import { Spinner } from '../../design/components/Spinner';
import { Format } from '../../design/format';
import { ChevronDownIcon, SlidersIcon } from '../../design/icons';
import type { ChartStore } from './ChartStore';
import { CHART_INTERVALS } from './ChartStore';
import { CandleChart, type OverlaySeries } from './CandleChart';
import { overlayPalette, panePalette } from './chartColors';
import { DrawToolsMenu } from './DrawingToolbar';
import type { DrawingsStore } from './drawings';
import { IndicatorPane, type PaneSeries } from './IndicatorPane';
import { PaneCard, type PaneReadout } from './PaneCard';
import * as engine from './indicatorEngine';
import { enabledSubPanes, type SubPaneKey } from './indicatorSettings';
import { useOptionsAnalytics } from './optionsAnalytics/useOptionsAnalytics';
import { computeTwc } from './twc/computeTwc';
import type { TwcBanner } from './twc/twcTypes';
import { intervalSeconds } from './ChartStore';
import './chart.css';

interface ChartViewProps {
  store: ChartStore;
  drawingsStore: DrawingsStore;
  apiClient: ApiClient;
  onSymbolSearch: () => void;
  onIndicatorSettings: () => void;
  tradingMode: TradingMode;
  onToggleMode: () => void;
  /** Trade-ticket expiration for the exact options snapshot; null pauses shadow capture. */
  optionsAnalyticsExpiration: string | null;
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

const INTERVAL_HINTS: Partial<Record<ChartInterval, string>> = {
  '1m': '1',
  '5m': '5',
  '15m': '3',
  '30m': '0',
  '1h': '⇧H',
  '4h': '4',
  '1d': '⇧D',
  '1w': '⇧W',
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
  optionsAnalyticsExpiration,
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
  } = useStore(store);

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

  const overlays = useMemo<OverlaySeries[]>(() => {
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
      result.push({ id: 'bollingerUpper', color: colors.bollingerUpper, values: bands.upper });
      result.push({
        id: 'bollingerMiddle',
        color: colors.bollingerMiddle,
        values: bands.middle,
      });
      result.push({ id: 'bollingerLower', color: colors.bollingerLower, values: bands.lower });
    }
    return result;
  }, [candles, closes, indicatorSettings]);

  const twcModel = useMemo(
    () => computeTwc(candles, twcSettings, intervalSeconds(interval)),
    [candles, twcSettings, interval],
  );

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

  const rsiSeries = useMemo<PaneSeries[] | null>(() => {
    if (!indicatorSettings.rsiEnabled) return null;
    return [
      {
        id: 'rsi',
        kind: 'line',
        color: panePalette().rsi,
        values: engine.rsi(candles, indicatorSettings.rsiPeriod),
      },
    ];
  }, [candles, indicatorSettings.rsiEnabled, indicatorSettings.rsiPeriod]);

  // Sub-panes are capped (MAX_SUB_PANES); only panes inside the cap render.
  const visiblePanes = useMemo<Set<SubPaneKey>>(
    () => new Set(enabledSubPanes(indicatorSettings)),
    [indicatorSettings],
  );

  const macdSeries = useMemo<PaneSeries[] | null>(() => {
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
        kind: 'histogram',
        positiveColor: colors.macdPositive,
        negativeColor: colors.macdNegative,
        values: values.histogram,
      },
      { id: 'macd', kind: 'line', color: colors.macd, values: values.macdLine },
      { id: 'macdSignal', kind: 'line', color: colors.macdSignal, values: values.signalLine },
    ];
  }, [
    candles,
    indicatorSettings.macdEnabled,
    indicatorSettings.macdFastPeriod,
    indicatorSettings.macdSlowPeriod,
    indicatorSettings.macdSignalPeriod,
  ]);

  const stochSeries = useMemo<PaneSeries[] | null>(() => {
    if (!indicatorSettings.stochEnabled) return null;
    const values = engine.stochastic(
      candles,
      indicatorSettings.stochKPeriod,
      indicatorSettings.stochKSmooth,
      indicatorSettings.stochDPeriod,
    );
    const colors = panePalette();
    return [
      { id: 'stochK', kind: 'line', color: colors.stochK, values: values.k },
      { id: 'stochD', kind: 'line', color: colors.stochD, values: values.d },
    ];
  }, [
    candles,
    indicatorSettings.stochEnabled,
    indicatorSettings.stochKPeriod,
    indicatorSettings.stochKSmooth,
    indicatorSettings.stochDPeriod,
  ]);

  const atrSeries = useMemo<PaneSeries[] | null>(() => {
    if (!indicatorSettings.atrEnabled) return null;
    return [
      {
        id: 'atr',
        kind: 'line',
        color: panePalette().atr,
        values: engine.atr(candles, indicatorSettings.atrPeriod),
      },
    ];
  }, [candles, indicatorSettings.atrEnabled, indicatorSettings.atrPeriod]);

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
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div
        className="hud-chip hud-card--flat"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          margin: '3px 8px 0',
          padding: '4px 6px',
          flex: 'none',
        }}
      >
        <button
          className="hud-chip"
          style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 6px' }}
          onClick={onSymbolSearch}
          aria-label={`Symbol ${symbol}. Change symbol`}
        >
          <span
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'var(--fs-subheadline)',
              fontWeight: 700,
              letterSpacing: '0.03em',
            }}
          >
            {symbol}
          </span>
          <span aria-hidden="true" style={{ display: 'flex', color: 'var(--app-accent)' }}>
            <ChevronDownIcon size={12} />
          </span>
        </button>

        {quote ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 18,
                  fontWeight: 600,
                  fontVariantNumeric: 'tabular-nums',
                  textShadow: '0 0 8px var(--hud-glow)',
                }}
              >
                {Format.price(quote.last)}
              </span>
              {isStale ? (
                <span
                  style={{
                    fontSize: 'var(--fs-caption2)',
                    color: 'var(--warning-orange)',
                    fontWeight: 600,
                  }}
                >
                  ● STALE
                </span>
              ) : null}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-caption2)',
                fontVariantNumeric: 'tabular-nums',
                display: 'flex',
                gap: 10,
              }}
            >
              <span>
                <span style={{ color: 'var(--buy-green)', fontWeight: 600 }}>BID </span>
                <span style={{ color: 'var(--buy-green)' }}>{Format.price(quote.bid)}</span>
              </span>
              <span>
                <span style={{ color: 'var(--sell-red)', fontWeight: 600 }}>ASK </span>
                <span style={{ color: 'var(--sell-red)' }}>{Format.price(quote.ask)}</span>
              </span>
            </span>
          </div>
        ) : null}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          {tickProgress ? (
            <span
              className="quick-chip"
              style={{ fontSize: 'var(--fs-caption)', color: 'var(--label-secondary)' }}
              aria-label={`Building candle: ${tickProgress.count} of ${tickProgress.size} ticks`}
            >
              {tickProgress.count}/{tickProgress.size} ticks
            </span>
          ) : null}
          <button
            className={tradingMode === 'live' ? 'hud-badge hud-badge--live' : 'hud-badge'}
            onClick={onToggleMode}
            aria-label={`Trading mode ${tradingMode === 'live' ? 'LIVE' : 'PRACTICE'}. Switch mode`}
          >
            {tradingMode === 'live' ? 'LIVE' : 'PRACTICE'}
          </button>
          <Menu
            trigger={
              <button
                className="quick-chip"
                style={{ minHeight: 32, padding: '6px 10px' }}
                aria-label={`Chart interval ${interval}`}
                aria-haspopup="menu"
              >
                {interval}
              </button>
            }
            items={CHART_INTERVALS.map((option) => ({
              key: option,
              label: (
                <>
                  {option.toUpperCase()}
                  {INTERVAL_HINTS[option] ? (
                    <span
                      style={{
                        marginLeft: 12,
                        fontSize: 'var(--fs-caption)',
                        color: 'var(--label-secondary)',
                      }}
                    >
                      {INTERVAL_HINTS[option]}
                    </span>
                  ) : null}
                </>
              ),
              checked: option === interval,
              onSelect: () => store.selectInterval(option),
            }))}
          />
          <DrawToolsMenu store={drawingsStore} />
          <button
            className="chart-icon-button"
            onClick={onIndicatorSettings}
            aria-label="Indicator settings"
          >
            <SlidersIcon size={16} />
          </button>
        </div>
      </div>

      {/* Chart area: HUD card wrapping a chamfer-clipped canvas region. The
          glow is baked into the card raster — never a CSS filter here. */}
      <div
        className="hud-card hud-card--flat"
        style={{ flex: 1, minHeight: 100, margin: '3px 8px', padding: 0, display: 'flex' }}
      >
        <div className="hud-clip" style={{ flex: 1, minHeight: 0, position: 'relative' }}>
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
          />
          {twcModel?.banner ? <TwcBiasBanner banner={twcModel.banner} /> : null}
          {optionsAnalytics.enabled && optionsAnalyticsState.errorMessage ? (
            <div
              style={{
                position: 'absolute',
                bottom: 8,
                left: 56,
                fontSize: 'var(--fs-caption2)',
                color: 'var(--warning-orange)',
                pointerEvents: 'none',
                zIndex: 3,
              }}
            >
              Options analytics unavailable: {optionsAnalyticsState.errorMessage}
            </div>
          ) : null}
          {isLoading && candles.length === 0 ? (
            <div className="chart-skeleton" aria-hidden="true">
              {SKELETON_BARS.map((height, index) => (
                <div className="bar" key={index} style={{ height: `${height}%` }} />
              ))}
            </div>
          ) : isLoading ? (
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
          ) : null}
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
                style={{ borderColor: 'color-mix(in srgb, var(--pnl-negative) 60%, transparent)' }}
              >
                {errorMessage}
              </div>
            </div>
          ) : null}
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
    </div>
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

const BANNER_FONT_SIZES: Record<string, number> = {
  Tiny: 10,
  Small: 12,
  Normal: 14,
  Large: 17,
};

/** TWC bias banner pinned to one of nine chart positions (Pine table analog). */
function TwcBiasBanner({ banner }: { banner: TwcBanner }) {
  const [vPos, hPos] = banner.position.split(' ') as [string, string];
  // Pine renders the banner with a fully transparent background: text only.
  const style: React.CSSProperties = {
    position: 'absolute',
    zIndex: 3,
    pointerEvents: 'none',
    padding: '3px 10px',
    color: banner.color,
    fontSize: BANNER_FONT_SIZES[banner.size] ?? 10,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  };
  if (vPos === 'Top') style.top = 8;
  else if (vPos === 'Bottom') style.bottom = 8;
  else {
    style.top = '50%';
    style.transform = 'translateY(-50%)';
  }
  if (hPos === 'Left') style.left = 56;
  else if (hPos === 'Right') style.right = 8;
  else {
    style.left = '50%';
    style.transform = `${style.transform ?? ''} translateX(-50%)`.trim();
  }
  return <div style={style}>{banner.text}</div>;
}
