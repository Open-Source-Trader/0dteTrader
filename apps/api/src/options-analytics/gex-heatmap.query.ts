import { Injectable } from '@nestjs/common';
import type {
  GexDataQuality,
  GexHeatmapCell,
  GexHeatmapSnapshot,
  OptionsAnalyticsSnapshot,
  OptionsAnalyticsStrike,
} from '@0dtetrader/shared-types';
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
}

/**
 * Reshapes already-persisted `OptionsAnalyticsSnapshotRecord` history
 * (written every minute by OptionsAnalyticsCaptureService for core symbols,
 * and on-demand via the 'viewed' capture path for any symbol a client
 * requests) into heatmap-ready {timestamps[], strikes[], cells[]}.
 *
 * This performs no calculation and issues no Tradier requests — GEX is
 * already computed per-contract and aggregated per-strike by
 * options-analytics.engine.ts before it reaches storage. This service only
 * reads and reshapes what is already there.
 */
@Injectable()
export class GexHeatmapQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async getHeatmap(query: GexHeatmapQuery, now = new Date()): Promise<GexHeatmapSnapshot> {
    const rows = await this.prisma.optionsAnalyticsSnapshotRecord.findMany({
      where: {
        symbol: query.symbol,
        expiration: query.expiration,
        observedAt: { gte: query.from, lt: query.to },
      },
      orderBy: { bucket: 'asc' },
    });

    const timestamps: string[] = [];
    const spotSeries: number[] = [];
    const strikeSet = new Set<number>();
    const cells: GexHeatmapCell[] = [];
    const mostRecentObservedAt =
      rows.length > 0 ? rows[rows.length - 1].observedAt.getTime() : null;

    for (const row of rows) {
      const output = row.output as unknown as OptionsAnalyticsSnapshot;
      const timestamp = output.scope.observedAt;
      timestamps.push(timestamp);
      spotSeries.push(output.scope.spot);

      // Staleness is relative to "now" only for the most recent snapshot in
      // the window — that's the one a live heatmap is trusting as current.
      // Older cells are historical by definition, not stale.
      const isMostRecent = row.observedAt.getTime() === mostRecentObservedAt;
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
        const callGex = strikeRow.call?.gammaExposure ?? null;
        const putGexMagnitude = strikeRow.put?.gammaExposure ?? null;
        const putGex = putGexMagnitude === null ? null : -putGexMagnitude;
        const netGex = callGex === null && putGex === null ? null : (callGex ?? 0) + (putGex ?? 0);
        cells.push({
          timestamp,
          strike: strikeRow.strike,
          callGex,
          putGex,
          netGex,
          dataQuality: classifyCellQuality(strikeRow, output.scope.spot, isStale),
        });
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
}

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
