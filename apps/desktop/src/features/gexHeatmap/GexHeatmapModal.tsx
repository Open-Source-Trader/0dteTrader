import { useMemo } from 'react';
import { DesktopSheet } from '../../design/components/DesktopSheet';
import { Format } from '../../design/format';
import { GexHeatmap } from './GexHeatmap';
import { selectStrikesAroundSpot } from './gexHeatmapMath';
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
// OptionsChain has no OI/gamma fields). Strikes are generated around the live
// spot price so the modal works for any symbol; exposure magnitudes are
// synthetic placeholders (seeded by symbol) until a real GEX endpoint is
// wired in, so switching the selected underlying visibly changes the data.
function hashSymbol(symbol: string): number {
  let hash = 0;
  for (let i = 0; i < symbol.length; i += 1) {
    hash = (hash * 31 + symbol.charCodeAt(i)) % 97;
  }
  return hash;
}

function buildPlaceholderEntries(
  symbol: string,
  spotPrice: number,
  expirations: readonly string[],
): readonly GexHeatmapEntry[] {
  let strikeStep = 0.5;
  if (spotPrice >= 200) strikeStep = 5;
  else if (spotPrice >= 50) strikeStep = 1;
  const roundedSpot = Math.round(spotPrice / strikeStep) * strikeStep;
  const offsets = Array.from({ length: 41 }, (_, i) => i - 20);
  const seed = hashSymbol(symbol);

  return offsets.map((offset) => {
    const strike = roundedSpot + offset * strikeStep;
    const distance = Math.abs(offset);
    const baseMagnitude = Math.max(1, 60 - distance * 3 + (seed % 20));
    const cells = expirations.map((expiration, expIndex) => {
      const decay = 1 / (expIndex + 1);
      const sign = (offset + expIndex + seed) % 3 === 0 ? -1 : 1;
      const netGex = Math.round(sign * baseMagnitude * decay * 1_000_000 * (1 + (distance % 3)));
      return { expiration, netGex };
    });
    return { strike, cells };
  });
}

/** Desktop modal wrapper around GexHeatmap, opened from the chart rail's heatmap icon. */
export function GexHeatmapModal({
  symbol,
  spotPrice,
  bid,
  ask,
  expirations,
  onDismiss,
}: GexHeatmapModalProps) {
  const entries = useMemo(
    () => buildPlaceholderEntries(symbol, spotPrice, expirations),
    [symbol, spotPrice, expirations],
  );
  const visibleEntries = useMemo(
    () => selectStrikesAroundSpot(entries, spotPrice),
    [entries, spotPrice],
  );

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
      <GexHeatmap
        symbol={symbol}
        spotPrice={spotPrice}
        expirations={expirations}
        entries={visibleEntries}
      />
    </DesktopSheet>
  );
}
