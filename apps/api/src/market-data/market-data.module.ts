import { Module } from '@nestjs/common';
import { BrokerModule } from '../broker/broker.module';
import { CryptoDataService } from './crypto-data.service';
import { MarketDataController } from './market-data.controller';
import { StreamGateway } from './stream.gateway';

@Module({
  imports: [BrokerModule],
  controllers: [MarketDataController],
  providers: [CryptoDataService, StreamGateway],
})
export class MarketDataModule {}
