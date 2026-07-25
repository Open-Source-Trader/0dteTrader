import type { ChartInterval, TradingMode } from '@0dtetrader/shared-types';
import type { ChartStore, ChartStoreState } from '../chart/ChartStore';
import { CHART_INTERVALS, INTERVAL_HINTS } from '../chart/ChartStore';
import { Menu } from '../../design/components/Menu';
import { Format } from '../../design/format';
import {
  ChevronDownIcon,
  ClockIcon,
  LockIcon,
  LockOpenIcon,
  PersonCircleIcon,
  SlidersIcon,
} from '../../design/icons';

interface DesktopTopBarProps {
  chartStore: ChartStore;
  chart: ChartStoreState;
  onSymbolSearch: () => void;
  onIndicatorSettings: () => void;
  tradingMode: TradingMode;
  onToggleMode: () => void;
  locked: boolean;
  onToggleLock: () => void;
  onShowProfile: () => void;
  onShowHistory: () => void;
}

/**
 * Desktop grid's single top bar: one row for the whole app instead of a
 * generic app NavBar (logo, spanning the full width) stacked above the
 * chart's own header (symbol/price/controls). Symbol + live price/bid-ask
 * on the left (the thing being traded), interval/indicators in the middle
 * (chart controls), lock/history/profile on the right (global app actions)
 * — one coherent status line, terminal convention. The left/right groups
 * align with the chart canvas edges below (draw rail + card margin), not
 * the outer panel edges, so the whole bar reads as part of the chart.
 */
export function DesktopTopBar({
  chartStore,
  chart,
  onSymbolSearch,
  onIndicatorSettings,
  tradingMode,
  onToggleMode,
  locked,
  onToggleLock,
  onShowProfile,
  onShowHistory,
}: DesktopTopBarProps) {
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
              className="quick-chip"
              style={{ minHeight: 28, padding: '4px 8px' }}
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
          <SlidersIcon size={20} />
        </button>
      </span>

      <span className="desktop-top-bar-divider" aria-hidden="true" />

      {/* Order matches the icon's frequency of use: lock (most reached for
          while trading), history, profile (least frequent). */}
      <span className="desktop-top-bar-group">
        <button
          className="chart-icon-button chart-icon-button--sm"
          onClick={onToggleLock}
          aria-pressed={locked}
          aria-label={locked ? 'Unlock trading' : 'Lock trading'}
        >
          {locked ? <LockIcon size={20} /> : <LockOpenIcon size={20} />}
        </button>
        <button
          className="chart-icon-button chart-icon-button--sm"
          onClick={onShowHistory}
          aria-label="Trade history"
        >
          <ClockIcon size={20} />
        </button>
        <button
          className="chart-icon-button chart-icon-button--sm"
          onClick={onShowProfile}
          aria-label="Profile"
        >
          <PersonCircleIcon size={20} />
        </button>
      </span>
    </div>
  );
}
