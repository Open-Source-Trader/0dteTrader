import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CredentialsModule } from '../credentials/credentials.module';
import { EventTransportModule } from '../events/event-transport.module';
import { PrismaService } from '../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { OptionsAnalyticsCaptureService } from './options-analytics.capture';
import { OptionsAnalyticsController } from './options-analytics.controller';
import { OptionsAnalyticsService } from './options-analytics.service';
import { TradierClient } from './tradier.client';
import { TradierClientResolver } from './tradier-client.resolver';
import { IvAlertService } from './iv-alert.service';

@Module({
  imports: [CredentialsModule, EventTransportModule],
  controllers: [OptionsAnalyticsController],
  providers: [
    {
      // The shared fallback client, authenticated with TRADIER_API_TOKEN.
      provide: TradierClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService): TradierClient =>
        new TradierClient(
          config.get<string>('tradier.token') ?? '',
          config.get<string>('tradier.baseUrl') ?? 'https://api.tradier.com',
        ),
    },
    {
      // Built via factory so the class keeps its default TradierFactory
      // parameter (same pattern as the broker gateways).
      provide: TradierClientResolver,
      inject: [ConfigService, CredentialsService, PrismaService, TradierClient],
      useFactory: (
        config: ConfigService,
        credentials: CredentialsService,
        prisma: PrismaService,
        shared: TradierClient,
      ): TradierClientResolver => new TradierClientResolver(config, credentials, prisma, shared),
    },
    OptionsAnalyticsService,
    IvAlertService,
    OptionsAnalyticsCaptureService,
  ],
  exports: [
    OptionsAnalyticsService,
    IvAlertService,
    OptionsAnalyticsCaptureService,
    TradierClient,
    TradierClientResolver,
  ],
})
export class OptionsAnalyticsModule {}
