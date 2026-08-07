import { Injectable } from '@nestjs/common';
import type {
  GexDataQuality,
  GexHeatmapCell,
  GexHeatmapSnapshot,
  GexTermStructureCell,
  GexTermStructureSnapshot,
  OptionsAnalyticsSnapshot,
  OptionsAnalyticsStrike,
} from '@0dtetrader/shared-types';
import type { OptionsAnalyticsSnapshotRecord } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface GexHeatmapQuery {
  symbol: string;
  expiration: string;
  /** Inclusive lower bound on `observedAt`. */
  from: Date;
  /** Exclusive upper bound on `observedAt`. */
  to: Date;
  /** Strikes below/above the spot observed at the most recent snapshot in
   *  range are dropped once the window is known; undefined keeps every
   *  strike the stored snapshots contain. */
  strikeRangeAboveSpot?: number;
  strikeRangeBelowSpot?: number;
  /** Downsamples the underlying 1-minute capture history to one column per
   *  N minutes, matching the chart's selected candle interval. Each bucket
   *  keeps its last (most recent) snapshot as the representative — same
   *  "latest wins" rule the capture service's own 5-minute compaction uses.
   *  Defaults to 1 (no downsampling). */
  bucketMinutes?: number;
}

export interface GexTermStructureQuery {
  symbol: string;
  /** Only expirations with a stored snapshot are returned; this bounds how
   *  far back "latest" is allowed to reach, so a long-dead expiration with
   *  one stale row from weeks ago doesn't show up as current. */
  maxSnapshotAgeMs: number;
  strikeRangeAboveSpot?: number;
  strikeRangeBelowSpot?: number;
}

/**
 * Reshapes already-persisted `OptionsAnalyticsSnapshotRecord` history
 * (written every minute by OptionsAnalyticsCaptureService for core symbols,
 * and on-demand via the 'viewed' capture path for any symbol a client
 * requests) into heatmap-ready shapes.
 *
 * This performs no calculation and issues no Tradier requests — GEX is
 * already computed per-contract and aggregated per-strike by
 * options-analytics.engine.ts before it reaches storage. This service only
 * reads and reshapes what is already there.
 */
@Injectable()
export class GexHeatmapQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Strike x timestamp, one expiration over its capture history. Columns
   *  are gap-filled to a regular grid at `bucketMinutes` spacing across the
   *  whole [from, to) window — a bucket with no capture still gets a column
   *  (empty cells, `missingSpot` quality) rather than being skipped, so the
   *  displayed spacing always matches the requested interval instead of
   *  compressing to wherever sparse on-demand captures happened to land. */
  async getHeatmap(query: GexHeatmapQuery, now = new Date()): Promise<GexHeatmapSnapshot> {
    const allRows = await this.prisma.optionsAnalyticsSnapshotRecord.findMany({
      where: {
        symbol: query.symbol,
        expiration: query.expiration,
        observedAt: { gte: query.from, lt: query.to },
      },
      orderBy: { bucket: 'asc' },
    });
    const bucketMinutes = query.bucketMinutes ?? 1;
    const rowByBucket = downsampleByBucket(allRows, bucketMinutes);

    const timestamps: string[] = [];
    const spotSeries: (number | null)[] = [];
    const strikeSet = new Set<number>();
    const cells: GexHeatmapCell[] = [];
    const populatedBuckets = [...rowByBucket.keys()];
    const mostRecentBucket = populatedBuckets.length > 0 ? Math.max(...populatedBuckets) : null;

    for (const bucketStart of bucketStarts(query.from, query.to, bucketMinutes)) {
      const row = rowByBucket.get(bucketStart);
      if (!row) {
        // No capture landed in this window — emit the column with its
        // bucket-start time and no data, rather than omitting it, so column
        // spacing stays regular.
        timestamps.push(new Date(bucketStart).toISOString());
        spotSeries.push(null);
        continue;
      }
      const output = row.output as unknown as OptionsAnalyticsSnapshot;
      const timestamp = output.scope.observedAt;
      timestamps.push(timestamp);
      spotSeries.push(output.scope.spot);

      // Staleness is relative to "now" only for the most recent populated
      // bucket in the window — that's the one a live heatmap is trusting as
      // current. Older cells are historical by definition, not stale.
      const isMostRecent = bucketStart === mostRecentBucket;
      const isStale = !isMostRecent
        ? false
        : now.getTime() - row.observedAt.getTime() > STALE_THRESHOLD_MS;

      for (const strikeRow of output.strikes) {
        if (
          !withinWindow(
            strikeRow.strike,
            output.scope.spot,
            query.strikeRangeBelowSpot,
            query.strikeRangeAboveSpot,
          )
        ) {
          continue;
        }
        strikeSet.add(strikeRow.strike);
        cells.push(
          buildCell(
            timestamp,
            strikeRow,
            classifyCellQuality(strikeRow, output.scope.spot, isStale),
          ),
        );
      }
    }

    return {
      underlyingSymbol: query.symbol,
      expiration: query.expiration,
      spotSeries,
      timestamps,
      strikes: [...strikeSet].sort((a, b) => a - b),
      cells,
    };
  }

  /**
   * Strike x expiration: the single latest snapshot for each expiration that
   * has one, giving a term-structure view of GEX across the chain at
   * (approximately) one point in time. Every expiration's "latest" comes
   * from its own most recent capture, so two columns are not guaranteed to
   * share an exact timestamp — expirations don't all get viewed/captured on
   * the same cadence.
   */
  async getTermStructure(
    query: GexTermStructureQuery,
    now = new Date(),
  ): Promise<GexTermStructureSnapshot> {
    const since = new Date(now.getTime() - query.maxSnapshotAgeMs);
    // Upper bound is inclusive-of-now (+1ms) rather than `lt: now`, since a
    // snapshot captured in this same request (moments before this query
    // runs) can legitimately carry `observedAt === now`.
    const rows = await this.prisma.optionsAnalyticsSnapshotRecord.findMany({
      where: { symbol: query.symbol, observedAt: { gte: since, lt: new Date(now.getTime() + 1) } },
      orderBy: { bucket: 'asc' },
    });

    const latestByExpiration = new Map<string, OptionsAnalyticsSnapshotRecord>();
    for (const row of rows) {
      const existing = latestByExpiration.get(row.expiration);
      if (!existing || row.observedAt.getTime() > existing.observedAt.getTime()) {
        latestByExpiration.set(row.expiration, row);
      }
    }

    const expirations = [...latestByExpiration.keys()].sort();
    const strikeSet = new Set<number>();
    const cells: GexTermStructureCell[] = [];

    for (const expiration of expirations) {
      const row = latestByExpiration.get(expiration)!;
      const output = row.output as unknown as OptionsAnalyticsSnapshot;
      const isStale = now.getTime() - row.observedAt.getTime() > STALE_THRESHOLD_MS;

      for (const strikeRow of output.strikes) {
        if (
          !withinWindow(
            strikeRow.strike,
            output.scope.spot,
            query.strikeRangeBelowSpot,
            query.strikeRangeAboveSpot,
          )
        ) {
          continue;
        }
        strikeSet.add(strikeRow.strike);
        cells.push({
          ...buildCell(
            output.scope.observedAt,
            strikeRow,
            classifyCellQuality(strikeRow, output.scope.spot, isStale),
          ),
          expiration,
        });
      }
    }

    return {
      underlyingSymbol: query.symbol,
      expirations,
      strikes: [...strikeSet].sort((a, b) => a - b),
      cells,
    };
  }
}

function buildCell(
  timestamp: string,
  strikeRow: OptionsAnalyticsStrike,
  dataQuality: GexDataQuality,
): GexHeatmapCell {
  const callGex = strikeRow.call?.gammaExposure ?? null;
  const putGexMagnitude = strikeRow.put?.gammaExposure ?? null;
  const putGex = putGexMagnitude === null ? null : -putGexMagnitude;
  const netGex = callGex === null && putGex === null ? null : (callGex ?? 0) + (putGex ?? 0);
  return { timestamp, strike: strikeRow.strike, callGex, putGex, netGex, dataQuality };
}

/** One representative row (the latest) per `bucketMinutes`-wide window,
 *  keyed by bucket-start epoch ms. `bucketMinutes <= 1` treats every row as
 *  its own 1-minute bucket (no merging). */
function downsampleByBucket(
  rows: OptionsAnalyticsSnapshotRecord[],
  bucketMinutes: number,
): Map<number, OptionsAnalyticsSnapshotRecord> {
  const bucketMs = Math.max(1, bucketMinutes) * 60_000;
  const representativeByBucket = new Map<number, OptionsAnalyticsSnapshotRecord>();
  for (const row of rows) {
    const bucketStart = Math.floor(row.observedAt.getTime() / bucketMs) * bucketMs;
    const existing = representativeByBucket.get(bucketStart);
    if (!existing || row.observedAt.getTime() > existing.observedAt.getTime()) {
      representativeByBucket.set(bucketStart, row);
    }
  }
  return representativeByBucket;
}

/** Every bucket-start epoch ms in `[from, to)` at `bucketMinutes` spacing,
 *  ascending — the full column grid a gap-filled heatmap renders, whether or
 *  not a capture exists for each one. Capped so a large window with a small
 *  bucket size can't generate an unbounded number of empty columns. */
function bucketStarts(from: Date, to: Date, bucketMinutes: number): number[] {
  const bucketMs = Math.max(1, bucketMinutes) * 60_000;
  // Floor, not ceiling: the bucket containing `from` itself may hold data at
  // or after `from` (a row's own bucket start can fall before the window
  // begins while the row's observedAt is still >= from) — using the ceiling
  // here would skip that bucket's column and silently drop its data.
  const firstBucket = Math.floor(from.getTime() / bucketMs) * bucketMs;
  const starts: number[] = [];
  for (let bucket = firstBucket; bucket < to.getTime(); bucket += bucketMs) {
    starts.push(bucket);
    if (starts.length >= MAX_GAP_FILLED_COLUMNS) break;
  }
  return starts;
}

/** Matches the endpoint's historyWindowMinutes ceiling (24h) at the finest
 *  1-minute bucket size — the largest grid gap-filling can ever produce. */
const MAX_GAP_FILLED_COLUMNS = 24 * 60;

function withinWindow(
  strike: number,
  spot: number,
  below: number | undefined,
  above: number | undefined,
): boolean {
  if (below !== undefined && strike < spot - below) return false;
  if (above !== undefined && strike > spot + above) return false;
  return true;
}

/** Mirrors the 60s capture cadence: the latest snapshot in a query window is
 *  stale once it's more than two cycles old relative to read time. */
const STALE_THRESHOLD_MS = 120_000;

/**
 * Per-cell data quality, derived from the structured call/put legs the
 * engine already produced for this strike — not from parsing warning text.
 *
 * The engine's own contract validation (options-analytics.engine.ts) rejects
 * any contract with unusable open interest before it becomes a leg at all —
 * a `call`/`put` leg is only ever present with valid, non-null OI. So a
 * "missing open interest" cell shows up here as a fully absent leg (`call`
 * or `put` is `null`), not as a leg with a null OI field. Gamma, by
 * contrast, can be null on a present leg when the local IV solve failed for
 * that specific contract while OI/liquidity were still valid — that's the
 * only case this can positively identify as "missing gamma" rather than
 * "missing contract".
 */
function classifyCellQuality(
  strikeRow: OptionsAnalyticsStrike,
  spot: number,
  isStale: boolean,
): GexDataQuality {
  if (isStale) return 'stale';
  if (!Number.isFinite(spot) || spot <= 0) return 'missingSpot';

  const missingLeg = strikeRow.call === null || strikeRow.put === null;
  const missingGamma =
    (strikeRow.call !== null && strikeRow.call.gamma === null) ||
    (strikeRow.put !== null && strikeRow.put.gamma === null);

  if (missingLeg && missingGamma) return 'partial';
  if (missingLeg) return 'missingOpenInterest';
  if (missingGamma) return 'missingGamma';
  return 'complete';
}
