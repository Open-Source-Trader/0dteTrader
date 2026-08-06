import { DesktopSheet } from '../../design/components/DesktopSheet';
import { Format } from '../../design/format';
import { GexHeatmap } from './GexHeatmap';
import type { GexHeatmapEntry } from './types';
import './gexHeatmap.css';

interface GexHeatmapModalProps {
  symbol: string;
  spotPrice: number;
  bid: number | null;
  ask: number | null;
  expirations: readonly string[];
  onDismiss: () => void;
}

// No gamma-exposure feed exists in the API yet (see packages/shared-types —
// OptionsChain has no OI/gamma fields), so there is no real data to show.
// Always empty until a real GEX endpoint is wired in — never fabricate
// exposure values.
const entries: readonly GexHeatmapEntry[] = [];

/** Desktop modal wrapper around GexHeatmap, opened from the chart rail's heatmap icon. */
export function GexHeatmapModal({
  symbol,
  spotPrice,
  bid,
  ask,
  expirations,
  onDismiss,
}: GexHeatmapModalProps) {
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
      </div>
      {entries.length === 0 ? (
        <div className="gex-heatmap-modal__unavailable">GEX data unavailable</div>
      ) : (
        <GexHeatmap
          symbol={symbol}
          spotPrice={spotPrice}
          expirations={expirations}
          entries={entries}
        />
      )}
    </DesktopSheet>
  );
}
