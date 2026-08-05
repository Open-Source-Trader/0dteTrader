import { Module } from '@nestjs/common';
import { BrokerModule } from '../broker/broker.module';
import { ChartOrdersModule } from '../chart-orders/chart-orders.module';
import { EventBridgeService } from './event-bridge.service';
import { EventTransportService } from './event-transport.service';

@Module({
  imports: [BrokerModule, ChartOrdersModule],
  providers: [EventTransportService, EventBridgeService],
  exports: [EventTransportService],
})
export class EventsModule {}
