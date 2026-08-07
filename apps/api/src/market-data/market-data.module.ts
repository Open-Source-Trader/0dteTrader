import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrokerModule } from '../broker/broker.module';
import { WebullClient } from '../broker/webull/webull-client';
import { ChartOrdersModule } from '../chart-orders/chart-orders.module';
import { EventsModule } from '../events/events.module';
import { OptionsAnalyticsModule } from '../options-analytics/options-analytics.module';
import { CryptoDataService } from './crypto-data.service';
import { IndexDataService } from './index-data.service';
import { MarketDataController } from './market-data.controller';
import { AppKeyRateLimiter, RedisRateLease } from './order-book-rate-limiter';
import { WebullClientOrderBookTransport, WebullOrderBookProvider } from './order-book.provider';
import { OrderBookService } from './order-book.service';
import { StreamGateway } from './stream.gateway';
import { TradierMarketDataService } from './tradier-market-data.service';

@Module({
  imports: [BrokerModule, OptionsAnalyticsModule, ChartOrdersModule, EventsModule],
  controllers: [MarketDataController],
  providers: [
    CryptoDataService,
    IndexDataService,
    TradierMarketDataService,
    RedisRateLease,
    {
      provide: WebullClientOrderBookTransport,
      inject: [ConfigService],
      useFactory: (config: ConfigService): WebullClientOrderBookTransport => {
        const client = new WebullClient(
          {
            appKey: config.get<string>('webull.l2AppKey') ?? '',
            appSecret: config.get<string>('webull.l2AppSecret') ?? '',
          },
          {
            hosts: {
              api: config.get<string>('webull.liveApiBaseUrl') ?? 'https://api.webull.com',
              data:
                config.get<string>('webull.liveMarketDataBaseUrl') ?? 'https://data-api.webull.com',
            },
          },
        );
        return new WebullClientOrderBookTransport(client);
      },
    },
    {
      provide: WebullOrderBookProvider,
      inject: [WebullClientOrderBookTransport, ConfigService],
      useFactory: (
        transport: WebullClientOrderBookTransport,
        config: ConfigService,
      ): WebullOrderBookProvider =>
        new WebullOrderBookProvider(transport, {
          enabled: config.get<boolean>('webull.l2Enabled') ?? false,
          capabilityProven: config.get<boolean>('webull.l2CapabilityProven') ?? false,
          maxDepth: config.get<number>('webull.l2MaxDepth') ?? 50,
          appKey: config.get<string>('webull.l2AppKey') ?? '',
        }),
    },
    {
      provide: AppKeyRateLimiter,
      inject: [RedisRateLease],
      useFactory: (lease: RedisRateLease): AppKeyRateLimiter => new AppKeyRateLimiter(lease),
    },
    {
      provide: OrderBookService,
      inject: [WebullOrderBookProvider, AppKeyRateLimiter, ConfigService],
      useFactory: (
        provider: WebullOrderBookProvider,
        limiter: AppKeyRateLimiter,
        config: ConfigService,
      ): OrderBookService =>
        new OrderBookService(provider, limiter, {
          maxLevels: config.get<number>('webull.l2MaxDepth') ?? 50,
        }),
    },
    StreamGateway,
  ],
})
export class MarketDataModule {}
