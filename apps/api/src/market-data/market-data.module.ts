import { Module } from '@nestjs/common';
import { BrokerModule } from '../broker/broker.module';
import { OptionsAnalyticsModule } from '../options-analytics/options-analytics.module';
import { CryptoDataService } from './crypto-data.service';
import { IndexDataService } from './index-data.service';
import { MarketDataController } from './market-data.controller';
import { StreamGateway } from './stream.gateway';
import { TradierMarketDataService } from './tradier-market-data.service';

@Module({
  imports: [BrokerModule, OptionsAnalyticsModule],
  controllers: [MarketDataController],
  providers: [CryptoDataService, IndexDataService, StreamGateway, TradierMarketDataService],
})
export class MarketDataModule {}
