import { useEffect, useMemo, useState } from 'react';
import type { CandleInterval, TradingMode } from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { useStore } from '../../core/observable';
import { Menu } from '../../design/components/Menu';
import { Spinner } from '../../design/components/Spinner';
import { Format } from '../../design/format';
import { ChevronDownIcon, SlidersIcon } from '../../design/icons';
import type { ChartStore } from './ChartStore';
import { CHART_INTERVALS } from './ChartStore';
import { CandleChart, type OverlaySeries, type VisibleRange } from './CandleChart';
import { overlayPalette, panePalette } from './chartColors';
import { DrawToolsMenu } from './DrawingToolbar';
import type { DrawingsStore } from './drawings';
import { useGexLevels } from './gex/useGexLevels';
import { IndicatorPane, type PaneSeries } from './IndicatorPane';
import * as engine from './indicatorEngine';
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
}

// Interval hotkeys. 'H'/'D' are uppercase (shift held) so they don't collide
// with the drawing-tool hotkeys (plain v/t/r/h/b/a in DrawingLayer).
const INTERVAL_SHORTCUTS: Record<string, CandleInterval> = {
  '1': '1m',
  '5': '5m',
  '3': '15m',
  H: '1h',
  D: '1d',
};

const INTERVAL_HINTS: Record<CandleInterval, string> = {
  '1m': '1',
  '5m': '5',
  '15m': '3',
  '1h': '⇧H',
  '1d': '⇧D',
};

// Seeded pseudo-random bar heights for the empty-chart loading skeleton.
const SKELETON_BARS = [
  42, 65, 58, 71, 49, 80, 63, 55, 74, 60, 45, 68, 77, 52, 66, 58, 70, 48, 62, 75, 56, 67, 50, 72,
];

/** Chart surface: header, candle chart with overlays and drawing tools, sub-panes. */
export function ChartView({ store, drawingsStore, apiClient, onSymbolSearch, onIndicatorSettings, tradingMode, onToggleMode }: ChartViewProps) {
  const {
    symbol,
    interval,
    candles,
    quote,
    isLoading,
    errorMessage,
    isStale,
    indicatorSettings,
    twcSettings,
    gexSettings,
  } = useStore(store);

  // Main chart's visible x-range, mirrored into every sub-pane.
  const [visibleRange, setVisibleRange] = useState<VisibleRange | null>(null);

  // GEX/DEX levels poll the API while the script is enabled. Levels are
  // symbol-keyed server-side: suppress a stale previous symbol's overlay
  // while the new symbol's first fetch is in flight.
  const gex = useGexLevels(apiClient, symbol, gexSettings);
  const gexLevels = gex.levels && gex.levels.symbol === symbol ? gex.levels : null;

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
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 16px',
          flex: 'none',
        }}
      >
        <button
          style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '10px 8px' }}
          onClick={onSymbolSearch}
          aria-label={`Symbol ${symbol}. Change symbol`}
        >
          <span style={{ fontSize: 'var(--fs-headline)', fontWeight: 600 }}>{symbol}</span>
          <span aria-hidden="true" style={{ display: 'flex' }}>
            <ChevronDownIcon size={12} />
          </span>
        </button>

        {quote ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--fs-body)',
                  fontWeight: 500,
                  fontVariantNumeric: 'tabular-nums',
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
              className="text-secondary"
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-caption2)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              B {Format.price(quote.bid)}&nbsp;&nbsp;A {Format.price(quote.ask)}
            </span>
          </div>
        ) : null}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={onToggleMode}
            aria-label={`Trading mode ${tradingMode === 'live' ? 'LIVE' : 'PRACTICE'}. Switch mode`}
            style={{
              fontSize: 'var(--fs-caption2)',
              color: tradingMode === 'live' ? 'var(--pnl-positive)' : '#ff9f0a',
              fontWeight: 700,
              letterSpacing: '0.04em',
            }}
          >
            {tradingMode === 'live' ? 'LIVE' : 'PRACTICE'}
          </button>
          <DrawToolsMenu store={drawingsStore} />
          <Menu
            trigger={
              <button
                className="quick-chip"
                style={{ minHeight: 36 }}
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
                  {option}
                  <span
                    style={{
                      marginLeft: 12,
                      fontSize: 'var(--fs-caption)',
                      color: 'var(--label-secondary)',
                    }}
                  >
                    {INTERVAL_HINTS[option]}
                  </span>
                </>
              ),
              checked: option === interval,
              onSelect: () => store.selectInterval(option),
            }))}
          />
          <button
            className="chart-icon-button"
            onClick={onIndicatorSettings}
            aria-label="Indicator settings"
          >
            <SlidersIcon size={16} />
          </button>
        </div>
      </div>

      {/* Chart area */}
      <div style={{ flex: 1, minHeight: 100, position: 'relative' }}>
        <CandleChart
          candles={candles}
          overlays={twcLineOverlays.length > 0 ? [...overlays, ...twcLineOverlays] : overlays}
          symbol={symbol}
          interval={interval}
          showVolume={indicatorSettings.volumeEnabled}
          drawingsStore={drawingsStore}
          candleColors={twcModel?.candleColors ?? null}
          twcModel={twcModel}
          gexLevels={gexLevels}
          gexSettings={gexSettings.enabled ? gexSettings : null}
          gexStale={gex.stale}
          onVisibleRangeChange={setVisibleRange}
        />
        {twcModel?.banner ? <TwcBiasBanner banner={twcModel.banner} /> : null}
        {gex.errorMessage ? (
          <div
            role="status"
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
            GEX unavailable: {gex.errorMessage}
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

      {rsiSeries ? (
        <IndicatorPane
          height={72}
          candles={candles}
          series={rsiSeries}
          guideLines={[30, 70]}
          yRange={[0, 100]}
          visibleRange={visibleRange}
        />
      ) : null}
      {macdSeries ? (
        <IndicatorPane height={80} candles={candles} series={macdSeries} visibleRange={visibleRange} />
      ) : null}
      {stochSeries ? (
        <IndicatorPane
          height={72}
          candles={candles}
          series={stochSeries}
          guideLines={[20, 80]}
          yRange={[0, 100]}
          visibleRange={visibleRange}
        />
      ) : null}
      {atrSeries ? (
        <IndicatorPane height={72} candles={candles} series={atrSeries} visibleRange={visibleRange} />
      ) : null}
    </div>
  );
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
