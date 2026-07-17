import { Module } from '@nestjs/common';
import { BrokerModule } from '../broker/broker.module';
import { MarketDataController } from './market-data.controller';
import { StreamGateway } from './stream.gateway';

@Module({
  imports: [BrokerModule],
  controllers: [MarketDataController],
  providers: [StreamGateway],
})
export class MarketDataModule {}
