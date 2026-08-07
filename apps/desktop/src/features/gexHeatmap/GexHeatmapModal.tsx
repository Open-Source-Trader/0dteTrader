import { useEffect, useState } from 'react';
import type { ChartInterval } from '@0dtetrader/shared-types';
import type { GexHeatmapViewMode } from '../../core/storage/SettingsStore';
import { useContainer } from '../../app/container';
import { errorMessage } from '../../core/api/ApiError';
import { DesktopSheet } from '../../design/components/DesktopSheet';
import { Format } from '../../design/format';
import { GexHeatmap } from './GexHeatmap';
import {
  gexBucketMinutes,
  termStructureToEntries,
  timeSeriesToEntries,
} from './gexHeatmapAdapters';
import type { GexHeatmapColumn, GexHeatmapEntry } from './types';
import './gexHeatmap.css';

interface GexHeatmapModalProps {
  symbol: string;
  spotPrice: number;
  bid: number | null;
  ask: number | null;
  /** Every expiration for the current chain, for the time-series picker. */
  expirations: readonly string[];
  /** Default expiration for the time-series view — the chain's current
   *  selection — until the user picks a different one in the sheet. */
  selectedExpiration: string | null;
  /** Downsamples the time-series columns to match the chart's candle size. */
  chartInterval: ChartInterval;
  onDismiss: () => void;
}

interface LoadedGrid {
  columns: GexHeatmapColumn[];
  entries: GexHeatmapEntry[];
}

/** Fraction of spot price to request above/below spot — an unbounded chain
 *  can be 400+ strikes wide, and rendering that many rows (times up to 60
 *  time-series columns) is what made the grid slow. strikeRangeAboveSpot/
 *  BelowSpot are dollar distances, not strike counts, so this has to scale
 *  with price rather than being a fixed constant (a fixed $10 window is way
 *  too wide for a $50 stock with $1 strikes and returns nothing for a $1500
 *  stock with $50 strikes). */
const STRIKE_WINDOW_FRACTION = 0.08;

function strikeWindow(spotPrice: number): number {
  return Math.ceil(Math.max(5, spotPrice * STRIKE_WINDOW_FRACTION));
}

/** Desktop modal wrapper around GexHeatmap, opened from the chart rail's heatmap icon. */
export function GexHeatmapModal({
  symbol,
  spotPrice,
  bid,
  ask,
  expirations,
  selectedExpiration,
  chartInterval,
  onDismiss,
}: GexHeatmapModalProps) {
  const { apiClient, settingsStore } = useContainer();
  const [viewMode, setViewMode] = useState<GexHeatmapViewMode>(() => settingsStore.gexHeatmapView);
  // Time series' own expiration choice, independent of term structure (which
  // always spans every near expiration) — defaults to the chain's current
  // selection but is user-changeable within the sheet.
  const [timeSeriesExpiration, setTimeSeriesExpiration] = useState<string | null>(
    selectedExpiration,
  );
  const [grid, setGrid] = useState<LoadedGrid | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setGrid(null);
    setError(null);
    setIsLoading(true);
    const window = strikeWindow(spotPrice);
    const request =
      viewMode === 'termStructure'
        ? apiClient
            .gexTermStructure(symbol, {
              expiration: selectedExpiration ?? undefined,
              strikeRangeAboveSpot: window,
              strikeRangeBelowSpot: window,
              signal: controller.signal,
            })
            .then(termStructureToEntries)
        : apiClient
            .gexHeatmap(symbol, {
              expiration: timeSeriesExpiration ?? undefined,
              bucketMinutes: gexBucketMinutes(chartInterval),
              strikeRangeAboveSpot: window,
              strikeRangeBelowSpot: window,
              signal: controller.signal,
            })
            .then(timeSeriesToEntries);
    request
      .then((result) => {
        if (!cancelled) setGrid(result);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // spotPrice is deliberately excluded: it ticks on every quote update, and
    // a coarse strike window doesn't need to be refetched on every cent of
    // movement — only when the sheet opens or the view/expiration changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiClient, symbol, selectedExpiration, timeSeriesExpiration, chartInterval, viewMode]);

  function selectViewMode(mode: GexHeatmapViewMode) {
    settingsStore.gexHeatmapView = mode;
    setViewMode(mode);
  }

  function renderBody() {
    if (error) {
      return <div className="gex-heatmap-modal__unavailable">GEX data unavailable: {error}</div>;
    }
    if (grid && grid.entries.length > 0) {
      return (
        <GexHeatmap
          symbol={symbol}
          spotPrice={spotPrice}
          columns={grid.columns}
          entries={grid.entries}
        />
      );
    }
    return (
      <div className="gex-heatmap-modal__unavailable">
        {isLoading ? 'Loading GEX data…' : 'GEX data unavailable'}
      </div>
    );
  }

  return (
    <DesktopSheet onDismiss={onDismiss} panelClassName="gex-heatmap-modal-panel">
      <div className="gex-heatmap-modal__header">
        <span className="gex-heatmap-modal__symbol">{symbol}</span>
        <span className="gex-heatmap-modal__stat">
          <span className="gex-heatmap-modal__stat-label">Price</span>
          {Format.price(spotPrice)}
        </span>
        <span className="gex-heatmap-modal__stat">
          <span className="gex-heatmap-modal__stat-label">Bid</span>
          {bid !== null ? Format.price(bid) : '—'}
        </span>
        <span className="gex-heatmap-modal__stat">
          <span className="gex-heatmap-modal__stat-label">Ask</span>
          {ask !== null ? Format.price(ask) : '—'}
        </span>
        <div className="gex-heatmap-modal__view-toggle" role="group" aria-label="GEX heatmap view">
          <button
            type="button"
            className={`gex-heatmap-modal__view-button${viewMode === 'termStructure' ? ' gex-heatmap-modal__view-button--active' : ''}`}
            aria-pressed={viewMode === 'termStructure'}
            onClick={() => selectViewMode('termStructure')}
          >
            Term Structure
          </button>
          <button
            type="button"
            className={`gex-heatmap-modal__view-button${viewMode === 'timeSeries' ? ' gex-heatmap-modal__view-button--active' : ''}`}
            aria-pressed={viewMode === 'timeSeries'}
            onClick={() => selectViewMode('timeSeries')}
          >
            Time Series
          </button>
        </div>
        {viewMode === 'timeSeries' && expirations.length > 0 ? (
          <label className="gex-heatmap-modal__expiration-picker">
            <span className="gex-heatmap-modal__stat-label">Expiration</span>
            <select
              value={timeSeriesExpiration ?? ''}
              onChange={(event) => setTimeSeriesExpiration(event.target.value)}
            >
              {expirations.map((expiration) => (
                <option key={expiration} value={expiration}>
                  {expiration}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <div className="gex-heatmap-modal__body">{renderBody()}</div>
    </DesktopSheet>
  );
}
