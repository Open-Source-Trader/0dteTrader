import { Module } from '@nestjs/common';
import { EventTransportService } from './event-transport.service';

@Module({
  providers: [EventTransportService],
  exports: [EventTransportService],
})
export class EventTransportModule {}
