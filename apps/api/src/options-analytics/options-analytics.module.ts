import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OptionsAnalyticsCaptureService } from './options-analytics.capture';
import { OptionsAnalyticsController } from './options-analytics.controller';
import { OptionsAnalyticsService } from './options-analytics.service';
import { TradierClient } from './tradier.client';

@Module({
  controllers: [OptionsAnalyticsController],
  providers: [
    {
      provide: TradierClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService): TradierClient =>
        new TradierClient(
          config.get<string>('tradier.token') ?? '',
          config.get<string>('tradier.baseUrl') ?? 'https://api.tradier.com',
        ),
    },
    OptionsAnalyticsService,
    OptionsAnalyticsCaptureService,
  ],
  exports: [OptionsAnalyticsService, OptionsAnalyticsCaptureService, TradierClient],
})
export class OptionsAnalyticsModule {}
