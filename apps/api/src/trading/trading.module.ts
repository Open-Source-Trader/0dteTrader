import { Module } from '@nestjs/common';
import { BrokerModule } from '../broker/broker.module';
import { OptionsAnalyticsModule } from '../options-analytics/options-analytics.module';
import { OrdersService } from './orders.service';
import { TradingController } from './trading.controller';
import { TradingService } from './trading.service';
import { AutoScoringController } from './auto-scoring.controller';
import { AutoScoringPreferenceService } from './auto-scoring-preference.service';
import { AutoCandidatesService } from './auto-candidates.service';

@Module({
  imports: [BrokerModule, OptionsAnalyticsModule],
  controllers: [TradingController, AutoScoringController],
  providers: [TradingService, OrdersService, AutoScoringPreferenceService, AutoCandidatesService],
  // ChartOrdersModule fires triggered lines through TradingService so they get
  // the same kill switch, idempotency, re-validation, and audit as any order.
  exports: [TradingService, OrdersService, AutoScoringPreferenceService, AutoCandidatesService],
})
export class TradingModule {}
