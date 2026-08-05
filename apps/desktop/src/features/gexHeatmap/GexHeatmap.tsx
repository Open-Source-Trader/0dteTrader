import { useMemo } from 'react';
import { Format } from '../../design/format';
import {
  formatGexValue,
  getClosestStrike,
  getGexCellStyle,
  getMaxAbsoluteValue,
  sortEntriesByStrikeDescending,
} from './gexHeatmapMath';
import type { GexHeatmapEntry, GexHeatmapProps } from './types';

function gexAriaLabel(strike: number, expiration: string, value: number | null): string {
  if (value === null)
    return `Strike ${strike}, expiration ${expiration}, gamma exposure unavailable`;
  const normalized = value === 0 ? 0 : value;
  let polarity: 'positive' | 'negative' | 'zero' = 'zero';
  if (normalized > 0) polarity = 'positive';
  else if (normalized < 0) polarity = 'negative';
  return `Strike ${strike}, expiration ${expiration}, gamma exposure ${polarity} $${Math.abs(normalized).toLocaleString('en-US')}`;
}

interface ExposureCellProps {
  strike: number;
  expiration: string;
  value: number | null;
  maxAbsoluteValue: number;
}

function ExposureCell({ strike, expiration, value, maxAbsoluteValue }: ExposureCellProps) {
  const style = getGexCellStyle(value, maxAbsoluteValue);
  return (
    <td
      className="gex-heatmap__exposure-cell"
      style={{ background: style.background, borderColor: style.borderColor }}
      aria-label={gexAriaLabel(strike, expiration, value)}
    >
      <span className="gex-heatmap__exposure-value">{formatGexValue(value)}</span>
    </td>
  );
}

interface GexHeatmapRowProps {
  entry: GexHeatmapEntry;
  expirations: readonly string[];
  maxAbsoluteValue: number;
  isSpotRow: boolean;
}

function GexHeatmapRow({ entry, expirations, maxAbsoluteValue, isSpotRow }: GexHeatmapRowProps) {
  const cellByExpiration = new Map(entry.cells.map((cell) => [cell.expiration, cell.netGex]));
  return (
    <tr className={`gex-heatmap__row${isSpotRow ? ' gex-heatmap__row--spot' : ''}`}>
      <th scope="row" className="gex-heatmap__strike-cell">
        {Format.strike(entry.strike)}
      </th>
      {expirations.map((expiration) => (
        <ExposureCell
          key={expiration}
          strike={entry.strike}
          expiration={expiration}
          value={cellByExpiration.get(expiration) ?? null}
          maxAbsoluteValue={maxAbsoluteValue}
        />
      ))}
    </tr>
  );
}

function GexHeatmapHeader({ expirations }: { expirations: readonly string[] }) {
  return (
    <tr>
      <th scope="col" className="gex-heatmap__strike-cell gex-heatmap__col-heading">
        GEX
      </th>
      {expirations.map((expiration) => (
        <th key={expiration} scope="col" className="gex-heatmap__col-heading">
          {expiration}
        </th>
      ))}
    </tr>
  );
}

export function GexHeatmap({
  symbol,
  spotPrice,
  expirations,
  entries,
  className,
}: GexHeatmapProps) {
  const sortedEntries = useMemo(() => sortEntriesByStrikeDescending(entries), [entries]);
  const maxAbsoluteValue = useMemo(() => getMaxAbsoluteValue(sortedEntries), [sortedEntries]);
  const closestStrike = useMemo(
    () => getClosestStrike(sortedEntries, spotPrice),
    [sortedEntries, spotPrice],
  );

  return (
    <div
      className={`gex-heatmap${className ? ` ${className}` : ''}`}
      aria-label={`${symbol} GEX heatmap`}
    >
      <div className="gex-heatmap__grid-scroll">
        <table className="gex-heatmap__grid">
          <thead>
            <GexHeatmapHeader expirations={expirations} />
          </thead>
          <tbody>
            {sortedEntries.map((entry) => (
              <GexHeatmapRow
                key={entry.strike}
                entry={entry}
                expirations={expirations}
                maxAbsoluteValue={maxAbsoluteValue}
                isSpotRow={closestStrike === entry.strike}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
