import type { ChartInterval, TradingMode } from '@0dtetrader/shared-types';
import type { ChartStore, ChartStoreState } from '../chart/ChartStore';
import { CHART_INTERVALS, INTERVAL_HINTS } from '../chart/ChartStore';
import { Menu } from '../../design/components/Menu';
import { Format } from '../../design/format';
import { ChevronDownIcon, SlidersIcon } from '../../design/icons';

interface DesktopChartTopBarProps {
  chartStore: ChartStore;
  chart: ChartStoreState;
  onSymbolSearch: () => void;
  onIndicatorSettings: () => void;
  tradingMode: TradingMode;
  onToggleMode: () => void;
}

/**
 * Chart panel's own top bar: symbol + live price/bid-ask on the left (the
 * thing being traded), interval/mode/indicators on the right. Rendered
 * inside the resizable chart Panel (not the app shell), so its right edge
 * always sits at the chart's actual right edge — including while the user
 * is live-dragging the chart/ticket split — instead of a fixed position
 * that only lined up at the default split ratio.
 */
export function DesktopChartTopBar({
  chartStore,
  chart,
  onSymbolSearch,
  onIndicatorSettings,
  tradingMode,
  onToggleMode,
}: DesktopChartTopBarProps) {
  const { symbol, interval, quote, isStale, tickProgress } = chart;

  return (
    <div className="desktop-top-bar">
      <button
        className="chart-strip-symbol"
        onClick={onSymbolSearch}
        aria-label={`Symbol ${symbol}. Change symbol`}
      >
        <span>{symbol}</span>
        <ChevronDownIcon size={14} />
      </button>

      {quote ? (
        <span className="numeric chart-strip-quote">
          <span className="chart-strip-last">{Format.price(quote.last)}</span>
          <span style={{ color: 'var(--buy-green)' }}>{Format.price(quote.bid)}</span>
          <span style={{ color: 'var(--label-secondary)' }}>/</span>
          <span style={{ color: 'var(--sell-red)' }}>{Format.price(quote.ask)}</span>
          {isStale ? (
            <span style={{ color: 'var(--warning-orange)', fontWeight: 600 }}>STALE</span>
          ) : null}
        </span>
      ) : null}

      {tickProgress ? (
        <span className="numeric chart-strip-ticks">
          {tickProgress.count}/{tickProgress.size}
        </span>
      ) : null}

      <span className="desktop-top-bar-group" style={{ marginLeft: 'auto' }}>
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
              className="desktop-top-bar-chip"
              aria-label={`Chart interval ${interval}`}
              aria-haspopup="menu"
            >
              {interval}
            </button>
          }
          items={CHART_INTERVALS.map((option: ChartInterval) => ({
            key: option,
            label: (
              <>
                {option.toUpperCase()}
                {INTERVAL_HINTS[option] ? (
                  <span
                    style={{
                      marginLeft: 12,
                      fontSize: 'var(--fs-caption-desktop)',
                      color: 'var(--label-secondary)',
                    }}
                  >
                    {INTERVAL_HINTS[option]}
                  </span>
                ) : null}
              </>
            ),
            checked: option === interval,
            onSelect: () => chartStore.selectInterval(option),
          }))}
        />
        <button
          className="chart-icon-button chart-icon-button--sm"
          onClick={onIndicatorSettings}
          aria-label="Indicator settings"
        >
          <SlidersIcon size={22} />
        </button>
      </span>
    </div>
  );
}
