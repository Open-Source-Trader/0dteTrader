import type { GexHeatmapSnapshot, GexTermStructureSnapshot } from '@0dtetrader/shared-types';
import type { GexHeatmapColumn, GexHeatmapEntry } from './types';

function timeLabel(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Term structure: strike x expiration, columns labeled with the expiration date. */
export function termStructureToEntries(snapshot: GexTermStructureSnapshot): {
  columns: GexHeatmapColumn[];
  entries: GexHeatmapEntry[];
} {
  const columns = snapshot.expirations.map((expiration) => ({
    key: expiration,
    label: expiration,
  }));
  const byStrike = new Map<number, Map<string, number | null>>();
  for (const cell of snapshot.cells) {
    const row = byStrike.get(cell.strike) ?? new Map<string, number | null>();
    row.set(cell.expiration, cell.netGex);
    byStrike.set(cell.strike, row);
  }
  const entries = [...byStrike.entries()].map(([strike, byColumn]) => ({
    strike,
    cells: snapshot.expirations.map((expiration) => ({
      columnKey: expiration,
      netGex: byColumn.get(expiration) ?? null,
    })),
  }));
  return { columns, entries };
}

/** Time series: strike x timestamp, columns labeled with a local clock time. */
export function timeSeriesToEntries(snapshot: GexHeatmapSnapshot): {
  columns: GexHeatmapColumn[];
  entries: GexHeatmapEntry[];
} {
  const columns = snapshot.timestamps.map((timestamp) => ({
    key: timestamp,
    label: timeLabel(timestamp),
  }));
  const byStrike = new Map<number, Map<string, number | null>>();
  for (const cell of snapshot.cells) {
    const row = byStrike.get(cell.strike) ?? new Map<string, number | null>();
    row.set(cell.timestamp, cell.netGex);
    byStrike.set(cell.strike, row);
  }
  const entries = [...byStrike.entries()].map(([strike, byColumn]) => ({
    strike,
    cells: snapshot.timestamps.map((timestamp) => ({
      columnKey: timestamp,
      netGex: byColumn.get(timestamp) ?? null,
    })),
  }));
  return { columns, entries };
}
