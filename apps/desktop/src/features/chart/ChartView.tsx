import { useMemo } from 'react';
import { useStore } from '../../core/observable';
import { Menu } from '../../design/components/Menu';
import { Spinner } from '../../design/components/Spinner';
import { Format } from '../../design/format';
import { ChevronDownIcon, SlidersIcon } from '../../design/icons';
import type { ChartStore } from './ChartStore';
import { CHART_INTERVALS } from './ChartStore';
import { CandleChart, type OverlaySeries } from './CandleChart';
import { DrawToolsMenu } from './DrawingToolbar';
import type { DrawingsStore } from './drawings';
import { IndicatorPane, type PaneSeries } from './IndicatorPane';
import * as engine from './indicatorEngine';

// Mirrors ChartView.overlayColors (iOS dark system colors, see tokens.css).
const OVERLAY_COLORS: Record<string, string> = {
  sma: '#ff9f0a',
  ema: '#64d2ff',
  vwap: '#bf5af2',
  bollingerUpper: '#8e8e93',
  bollingerMiddle: '#40cbe0',
  bollingerLower: '#8e8e93',
};

interface ChartViewProps {
  store: ChartStore;
  drawingsStore: DrawingsStore;
  onSymbolSearch: () => void;
  onIndicatorSettings: () => void;
}

/** Chart surface: header, candle chart with overlays and drawing tools, sub-panes. */
export function ChartView({ store, drawingsStore, onSymbolSearch, onIndicatorSettings }: ChartViewProps) {
  const { symbol, interval, candles, quote, isLoading, errorMessage, indicatorSettings } =
    useStore(store);

  const closes = useMemo(() => candles.map((c) => c.close), [candles]);

  const overlays = useMemo<OverlaySeries[]>(() => {
    const result: OverlaySeries[] = [];
    if (indicatorSettings.smaEnabled) {
      result.push({
        id: 'sma',
        color: OVERLAY_COLORS.sma,
        values: engine.sma(closes, indicatorSettings.smaPeriod),
      });
    }
    if (indicatorSettings.emaEnabled) {
      result.push({
        id: 'ema',
        color: OVERLAY_COLORS.ema,
        values: engine.ema(closes, indicatorSettings.emaPeriod),
      });
    }
    if (indicatorSettings.vwapEnabled) {
      result.push({ id: 'vwap', color: OVERLAY_COLORS.vwap, values: engine.vwap(candles) });
    }
    if (indicatorSettings.bollingerEnabled) {
      const bands = engine.bollingerBands(
        candles,
        indicatorSettings.bollingerPeriod,
        indicatorSettings.bollingerMultiplier,
      );
      result.push({ id: 'bollingerUpper', color: OVERLAY_COLORS.bollingerUpper, values: bands.upper });
      result.push({
        id: 'bollingerMiddle',
        color: OVERLAY_COLORS.bollingerMiddle,
        values: bands.middle,
      });
      result.push({ id: 'bollingerLower', color: OVERLAY_COLORS.bollingerLower, values: bands.lower });
    }
    return result;
  }, [candles, closes, indicatorSettings]);

  const rsiSeries = useMemo<PaneSeries[] | null>(() => {
    if (!indicatorSettings.rsiEnabled) return null;
    return [
      {
        id: 'rsi',
        kind: 'line',
        color: '#ffd60a',
        values: engine.rsi(candles, indicatorSettings.rsiPeriod),
      },
    ];
  }, [candles, indicatorSettings.rsiEnabled, indicatorSettings.rsiPeriod]);

  const macdSeries = useMemo<PaneSeries[] | null>(() => {
    if (!indicatorSettings.macdEnabled) return null;
    const values = engine.macd(candles);
    return [
      {
        id: 'macdHistogram',
        kind: 'histogram',
        positiveColor: '#30d158',
        negativeColor: '#ff453a',
        values: values.histogram,
      },
      { id: 'macd', kind: 'line', color: '#0a84ff', values: values.macdLine },
      { id: 'macdSignal', kind: 'line', color: '#ff9f0a', values: values.signalLine },
    ];
  }, [candles, indicatorSettings.macdEnabled]);

  const stochSeries = useMemo<PaneSeries[] | null>(() => {
    if (!indicatorSettings.stochEnabled) return null;
    const values = engine.stochastic(
      candles,
      indicatorSettings.stochKPeriod,
      indicatorSettings.stochKSmooth,
      indicatorSettings.stochDPeriod,
    );
    return [
      { id: 'stochK', kind: 'line', color: '#0a84ff', values: values.k },
      { id: 'stochD', kind: 'line', color: '#ff9f0a', values: values.d },
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
        color: '#40cbe0',
        values: engine.atr(candles, indicatorSettings.atrPeriod),
      },
    ];
  }, [candles, indicatorSettings.atrEnabled, indicatorSettings.atrPeriod]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 12px',
          flex: 'none',
        }}
      >
        <button
          style={{ display: 'flex', alignItems: 'center', gap: 4 }}
          onClick={onSymbolSearch}
        >
          <span style={{ fontSize: 'var(--fs-headline)', fontWeight: 600 }}>{symbol}</span>
          <ChevronDownIcon size={11} />
        </button>

        {quote ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
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
          <DrawToolsMenu store={drawingsStore} />
          <Menu
            trigger={
              <button
                style={{
                  fontSize: 'var(--fs-caption)',
                  fontWeight: 600,
                  padding: '6px 10px',
                  background: 'var(--app-surface-elevated)',
                  borderRadius: 999,
                }}
              >
                {interval}
              </button>
            }
            items={CHART_INTERVALS.map((option) => ({
              key: option,
              label: option,
              checked: option === interval,
              onSelect: () => store.selectInterval(option),
            }))}
          />
          <button
            style={{
              padding: 8,
              background: 'var(--app-surface-elevated)',
              borderRadius: '50%',
              display: 'flex',
            }}
            onClick={onIndicatorSettings}
            aria-label="Indicator settings"
          >
            <SlidersIcon size={15} />
          </button>
        </div>
      </div>

      {/* Chart area */}
      <div style={{ flex: 1, minHeight: 100, position: 'relative' }}>
        <CandleChart
          candles={candles}
          overlays={overlays}
          interval={interval}
          showVolume={indicatorSettings.volumeEnabled}
          drawingsStore={drawingsStore}
        />
        {isLoading ? (
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
            className="text-secondary"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 'var(--fs-footnote)',
              padding: 16,
              textAlign: 'center',
            }}
          >
            {errorMessage}
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
        />
      ) : null}
      {macdSeries ? <IndicatorPane height={84} candles={candles} series={macdSeries} /> : null}
      {stochSeries ? (
        <IndicatorPane
          height={72}
          candles={candles}
          series={stochSeries}
          guideLines={[20, 80]}
          yRange={[0, 100]}
        />
      ) : null}
      {atrSeries ? <IndicatorPane height={72} candles={candles} series={atrSeries} /> : null}
    </div>
  );
}
