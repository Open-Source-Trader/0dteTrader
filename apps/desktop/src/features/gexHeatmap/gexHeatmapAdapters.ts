import type {
  ChartInterval,
  GexHeatmapSnapshot,
  GexTermStructureSnapshot,
} from '@0dtetrader/shared-types';
import type { GexHeatmapColumn, GexHeatmapEntry } from './types';

/** Maps the chart's candle interval to the GEX time-series bucket size, so a
 *  5m chart shows 5-minute GEX columns instead of the raw 1-minute capture
 *  cadence. GEX history has no tick-level granularity (it's captured on a
 *  wall-clock cadence, not per-trade), so a tick interval falls back to the
 *  finest bucket available. Capped at 60 — beyond that, term structure over
 *  hours already reads better as a daily view than a time series. */
export function gexBucketMinutes(interval: ChartInterval): number {
  switch (interval) {
    case '1m':
      return 1;
    case '5m':
      return 5;
    case '15m':
      return 15;
    case '30m':
      return 30;
    case '1h':
      return 60;
    case '4h':
    case '1d':
    case '1w':
      return 60;
    default:
      return 1;
  }
}

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
