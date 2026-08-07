import { Module } from '@nestjs/common';
import { BrokerModule } from '../broker/broker.module';
import { ChartOrdersModule } from '../chart-orders/chart-orders.module';
import { EventBridgeService } from './event-bridge.service';
import { EventTransportModule } from './event-transport.module';

@Module({
  imports: [BrokerModule, ChartOrdersModule, EventTransportModule],
  providers: [EventBridgeService],
  exports: [EventTransportModule],
})
export class EventsModule {}
