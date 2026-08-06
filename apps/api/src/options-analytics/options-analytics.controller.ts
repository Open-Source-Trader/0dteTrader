import { Controller, Get, Logger, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import type { GexHeatmapSnapshot, OptionsAnalyticsSnapshot } from '@0dtetrader/shared-types';
import { AuthenticatedUser, CurrentUser } from '../common/current-user.decorator';
import { GexHeatmapQueryService } from './gex-heatmap.query';
import { OptionsAnalyticsCaptureService } from './options-analytics.capture';
import { OptionsAnalyticsService } from './options-analytics.service';

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

const DEFAULT_HISTORY_WINDOW_MINUTES = 60;

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
    const result = await this.analytics.getSnapshotResult(
      query.symbol,
      query.expiration,
      user.userId,
    );
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
}
