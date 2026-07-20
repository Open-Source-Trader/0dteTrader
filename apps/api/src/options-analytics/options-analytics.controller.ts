import { Controller, Get, Logger, Query } from '@nestjs/common';
import { IsDateString, IsString, Matches } from 'class-validator';
import type { OptionsAnalyticsSnapshot } from '@0dtetrader/shared-types';
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

@Controller('market')
export class OptionsAnalyticsController {
  private readonly logger = new Logger(OptionsAnalyticsController.name);

  constructor(
    private readonly analytics: OptionsAnalyticsService,
    private readonly capture: OptionsAnalyticsCaptureService,
  ) {}

  @Get('options-analytics')
  async getSnapshot(@Query() query: OptionsAnalyticsQueryDto): Promise<OptionsAnalyticsSnapshot> {
    const result = await this.analytics.getSnapshotResult(query.symbol, query.expiration);
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
}
