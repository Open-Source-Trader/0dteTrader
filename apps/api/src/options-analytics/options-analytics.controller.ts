import { Controller, Get, Logger, Query, ServiceUnavailableException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import type {
  GexHeatmapSnapshot,
  GexTermStructureSnapshot,
  OptionsAnalyticsSnapshot,
} from '@0dtetrader/shared-types';
import { AuthenticatedUser, CurrentUser } from '../common/current-user.decorator';
import { GexHeatmapQueryService } from './gex-heatmap.query';
import { OptionsAnalyticsCaptureService } from './options-analytics.capture';
import {
  OptionsAnalyticsService,
  type OptionsAnalyticsSnapshotResult,
} from './options-analytics.service';

export class OptionsAnalyticsQueryDto {
  @IsString()
  @Matches(/^[A-Za-z0-9.-]{1,12}$/)
  symbol!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  expiration!: string;
}

export class GexHeatmapQueryDto {
  @IsString()
  @Matches(/^[A-Za-z0-9.-]{1,12}$/)
  symbol!: string;

  /** Omit for the nearest 0DTE expiration, same default as /options-analytics. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  expiration?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(500)
  strikeRangeAboveSpot?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(500)
  strikeRangeBelowSpot?: number;

  /** Minutes of history to return, ending now. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24 * 60)
  historyWindowMinutes?: number;
}

export class GexTermStructureQueryDto {
  @IsString()
  @Matches(/^[A-Za-z0-9.-]{1,12}$/)
  symbol!: string;

  /** The expiration to guarantee is fresh (a live snapshot is triggered for
   *  this one, same as gex-heatmap); omit for the nearest 0DTE. Other
   *  expirations in the result use whatever their own history last captured. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  expiration?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(500)
  strikeRangeAboveSpot?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(500)
  strikeRangeBelowSpot?: number;

  /** How far back an expiration's own latest snapshot may be and still count
   *  as "current" for the term-structure view. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24 * 60)
  maxSnapshotAgeMinutes?: number;
}

const DEFAULT_HISTORY_WINDOW_MINUTES = 60;
const DEFAULT_TERM_STRUCTURE_MAX_AGE_MINUTES = 60;

@Controller('market')
export class OptionsAnalyticsController {
  private readonly logger = new Logger(OptionsAnalyticsController.name);

  constructor(
    private readonly analytics: OptionsAnalyticsService,
    private readonly capture: OptionsAnalyticsCaptureService,
    private readonly gexHeatmap: GexHeatmapQueryService,
  ) {}

  @Get('options-analytics')
  async getSnapshot(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: OptionsAnalyticsQueryDto,
  ): Promise<OptionsAnalyticsSnapshot> {
    const result = await this.analytics.getSnapshotResult(
      query.symbol,
      query.expiration,
      user.userId,
    );
    // Only shared-client snapshots enter the global capture history: a
    // per-user-key result (possibly sandbox-quality) would claim the
    // symbol/expiration/bucket slot and silently displace the production
    // row the capture cron writes.
    if (result.scope !== 'shared') return result.snapshot;
    // Persistence failures are swallowed and logged by the capture service so
    // a valid interactive market-data response remains available.
    void this.capture.persist(result, 'viewed').catch((error: unknown) => {
      this.logger.error(
        JSON.stringify({
          event: 'options_analytics_viewed_capture_failed',
          symbol: result.snapshot.scope.symbol,
          expiration: result.snapshot.scope.expiration,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    });
    return result.snapshot;
  }

  /**
   * Heatmap-ready GEX time series. Reuses the same ingestion/capture path as
   * /options-analytics: a request here for a symbol/expiration that has no
   * recent history first triggers a live snapshot (which also performs the
   * same best-effort 'viewed' capture write /options-analytics does), so a
   * symbol outside the core capture list still starts accruing history the
   * moment someone opens its heatmap, without a second Tradier request or a
   * second timer.
   */
  @Get('options-analytics/gex-heatmap')
  async getGexHeatmap(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GexHeatmapQueryDto,
  ): Promise<GexHeatmapSnapshot> {
    const result = await this.resolveSnapshot(query.symbol, query.expiration, user.userId);
    const expiration = result.snapshot.scope.expiration;
    if (result.scope === 'shared') {
      // Awaited (unlike /options-analytics' fire-and-forget) so the snapshot
      // this request just fetched is guaranteed to be in the history query
      // below — otherwise the first heatmap request for a fresh symbol would
      // read back a window that doesn't yet include the point it triggered.
      try {
        await this.capture.persist(result, 'viewed');
      } catch (error) {
        this.logger.error(
          JSON.stringify({
            event: 'options_analytics_viewed_capture_failed',
            symbol: result.snapshot.scope.symbol,
            expiration,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }

    const historyWindowMinutes = query.historyWindowMinutes ?? DEFAULT_HISTORY_WINDOW_MINUTES;
    const to = new Date();
    const from = new Date(to.getTime() - historyWindowMinutes * 60_000);
    return this.gexHeatmap.getHeatmap({
      symbol: result.snapshot.scope.symbol,
      expiration,
      from,
      to,
      strikeRangeAboveSpot: query.strikeRangeAboveSpot,
      strikeRangeBelowSpot: query.strikeRangeBelowSpot,
    });
  }

  /**
   * Term-structure GEX: strike x expiration, using each expiration's own
   * latest capture. Triggers a live snapshot only for the one expiration the
   * caller names (or the nearest 0DTE) — the same single ingestion call
   * every other endpoint here uses — so opening this view does not fan out
   * into one Tradier request per expiration. Other columns reflect whatever
   * the core cron or a prior 'viewed' request already captured for them.
   */
  @Get('options-analytics/gex-term-structure')
  async getGexTermStructure(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GexTermStructureQueryDto,
  ): Promise<GexTermStructureSnapshot> {
    const result = await this.resolveSnapshot(query.symbol, query.expiration, user.userId);
    if (result.scope === 'shared') {
      try {
        await this.capture.persist(result, 'viewed');
      } catch (error) {
        this.logger.error(
          JSON.stringify({
            event: 'options_analytics_viewed_capture_failed',
            symbol: result.snapshot.scope.symbol,
            expiration: result.snapshot.scope.expiration,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }

    const maxSnapshotAgeMs =
      (query.maxSnapshotAgeMinutes ?? DEFAULT_TERM_STRUCTURE_MAX_AGE_MINUTES) * 60_000;
    return this.gexHeatmap.getTermStructure({
      symbol: result.snapshot.scope.symbol,
      maxSnapshotAgeMs,
      strikeRangeAboveSpot: query.strikeRangeAboveSpot,
      strikeRangeBelowSpot: query.strikeRangeBelowSpot,
    });
  }

  /**
   * Resolves a snapshot the same way /options-analytics does, except a
   * caller-supplied expiration that has settled since it was selected (a
   * 0DTE the client picked while the market was open, requested again
   * after close) falls back to the service's own default instead of
   * failing forever — that expiration can never succeed again today, so
   * without this a stale client-cached expiration turns into a permanent
   * error on every request until the next trading day.
   */
  private async resolveSnapshot(
    symbol: string,
    expiration: string | undefined,
    userId: string,
  ): Promise<OptionsAnalyticsSnapshotResult> {
    try {
      return await this.analytics.getSnapshotResult(symbol, expiration, userId);
    } catch (error) {
      if (expiration === undefined || !isOptionsAnalyticsUnavailable(error)) {
        throw error;
      }
      this.logger.warn(
        JSON.stringify({
          event: 'gex_expiration_fallback',
          symbol,
          requestedExpiration: expiration,
        }),
      );
      return this.analytics.getSnapshotResult(symbol, undefined, userId);
    }
  }
}

function isOptionsAnalyticsUnavailable(error: unknown): boolean {
  if (!(error instanceof ServiceUnavailableException)) return false;
  const response = error.getResponse();
  return (
    typeof response === 'object' &&
    response !== null &&
    (response as { code?: unknown }).code === 'OPTIONS_ANALYTICS_UNAVAILABLE'
  );
}
