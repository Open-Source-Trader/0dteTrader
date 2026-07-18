import { Module } from '@nestjs/common';
import { BrokerModule } from '../broker/broker.module';
import { OrdersService } from './orders.service';
import { TradingController } from './trading.controller';
import { TradingService } from './trading.service';

@Module({
  imports: [BrokerModule],
  controllers: [TradingController],
  providers: [TradingService, OrdersService],
})
export class TradingModule {}
