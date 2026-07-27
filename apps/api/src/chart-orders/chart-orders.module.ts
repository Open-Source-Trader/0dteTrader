import { Module } from '@nestjs/common';
import { BrokerModule } from '../broker/broker.module';
import { TradingModule } from '../trading/trading.module';
import { ChartOrderEventsService } from './chart-order-events.service';
import { ChartOrderWatcherService } from './chart-order-watcher.service';
import { ChartOrdersController } from './chart-orders.controller';
import { ChartOrdersService } from './chart-orders.service';

/**
 * Chart trading. Depends on TradingModule for the fire path so a triggered line
 * goes through exactly the same kill switch, idempotency claim, server-side
 * re-validation, and audit trail as a hand-placed order.
 */
@Module({
  imports: [BrokerModule, TradingModule],
  controllers: [ChartOrdersController],
  providers: [ChartOrdersService, ChartOrderEventsService, ChartOrderWatcherService],
  exports: [ChartOrdersService, ChartOrderEventsService],
})
export class ChartOrdersModule {}
