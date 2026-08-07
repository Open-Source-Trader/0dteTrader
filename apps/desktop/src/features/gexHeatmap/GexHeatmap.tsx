import { useEffect, useMemo, useRef } from 'react';
import { Format } from '../../design/format';
import {
  formatGexValue,
  getClosestStrike,
  getGexCellStyle,
  getMaxAbsoluteValue,
  sortEntriesByStrikeDescending,
} from './gexHeatmapMath';
import type { GexHeatmapColumn, GexHeatmapEntry, GexHeatmapProps } from './types';

function gexAriaLabel(strike: number, columnLabel: string, value: number | null): string {
  if (value === null) return `Strike ${strike}, ${columnLabel}, gamma exposure unavailable`;
  const normalized = value === 0 ? 0 : value;
  let polarity: 'positive' | 'negative' | 'zero' = 'zero';
  if (normalized > 0) polarity = 'positive';
  else if (normalized < 0) polarity = 'negative';
  return `Strike ${strike}, ${columnLabel}, gamma exposure ${polarity} $${Math.abs(normalized).toLocaleString('en-US')}`;
}

interface ExposureCellProps {
  strike: number;
  columnLabel: string;
  value: number | null;
  maxAbsoluteValue: number;
}

function ExposureCell({ strike, columnLabel, value, maxAbsoluteValue }: ExposureCellProps) {
  const style = getGexCellStyle(value, maxAbsoluteValue);
  return (
    <td
      className="gex-heatmap__exposure-cell"
      style={{ background: style.background, borderColor: style.borderColor }}
      aria-label={gexAriaLabel(strike, columnLabel, value)}
    >
      <span className="gex-heatmap__exposure-value">{formatGexValue(value)}</span>
    </td>
  );
}

interface GexHeatmapRowProps {
  entry: GexHeatmapEntry;
  columns: readonly GexHeatmapColumn[];
  maxAbsoluteValue: number;
  isSpotRow: boolean;
  spotRowRef?: React.RefObject<HTMLTableRowElement | null>;
}

function GexHeatmapRow({
  entry,
  columns,
  maxAbsoluteValue,
  isSpotRow,
  spotRowRef,
}: GexHeatmapRowProps) {
  const cellByColumn = new Map(entry.cells.map((cell) => [cell.columnKey, cell.netGex]));
  return (
    <tr
      ref={isSpotRow ? spotRowRef : undefined}
      className={`gex-heatmap__row${isSpotRow ? ' gex-heatmap__row--spot' : ''}`}
    >
      <th scope="row" className="gex-heatmap__strike-cell">
        {Format.strike(entry.strike)}
      </th>
      {columns.map((column) => (
        <ExposureCell
          key={column.key}
          strike={entry.strike}
          columnLabel={column.label}
          value={cellByColumn.get(column.key) ?? null}
          maxAbsoluteValue={maxAbsoluteValue}
        />
      ))}
    </tr>
  );
}

function GexHeatmapHeader({ columns }: { columns: readonly GexHeatmapColumn[] }) {
  return (
    <tr>
      <th scope="col" className="gex-heatmap__strike-cell gex-heatmap__col-heading">
        GEX
      </th>
      {columns.map((column) => (
        <th key={column.key} scope="col" className="gex-heatmap__col-heading">
          {column.label}
        </th>
      ))}
    </tr>
  );
}

export function GexHeatmap({ symbol, spotPrice, columns, entries, className }: GexHeatmapProps) {
  const sortedEntries = useMemo(() => sortEntriesByStrikeDescending(entries), [entries]);
  const maxAbsoluteValue = useMemo(() => getMaxAbsoluteValue(sortedEntries), [sortedEntries]);
  const closestStrike = useMemo(
    () => getClosestStrike(sortedEntries, spotPrice),
    [sortedEntries, spotPrice],
  );
  const spotRowRef = useRef<HTMLTableRowElement>(null);
  const centeredOnce = useRef(false);

  // Centers the spot-price row in the sheet's scroll container the first
  // time real rows render — once only, so scrolling to look around the grid
  // isn't fought on every re-render (e.g. a live-refreshing time series).
  useEffect(() => {
    if (centeredOnce.current || sortedEntries.length === 0 || !spotRowRef.current) return;
    centeredOnce.current = true;
    // jsdom (unit tests) doesn't implement scrollIntoView.
    spotRowRef.current.scrollIntoView?.({ block: 'center' });
  }, [sortedEntries]);

  return (
    <div
      className={`gex-heatmap${className ? ` ${className}` : ''}`}
      aria-label={`${symbol} GEX heatmap`}
    >
      <table className="gex-heatmap__grid">
        <thead>
          <GexHeatmapHeader columns={columns} />
        </thead>
        <tbody>
          {sortedEntries.map((entry) => (
            <GexHeatmapRow
              key={entry.strike}
              entry={entry}
              columns={columns}
              maxAbsoluteValue={maxAbsoluteValue}
              isSpotRow={closestStrike === entry.strike}
              spotRowRef={closestStrike === entry.strike ? spotRowRef : undefined}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
