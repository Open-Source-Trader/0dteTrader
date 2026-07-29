import { IsIn, IsOptional } from 'class-validator';
import {
  BROKER_PROVIDERS,
  BrokerProvider,
  TRADING_MODES,
  TradingMode,
} from '@0dtetrader/shared-types';

export class UpdateMeDto {
  @IsOptional()
  @IsIn(TRADING_MODES)
  tradingMode?: TradingMode;

  /** Active trading provider. Optional so the same endpoint can flip the
   *  mode, the provider, or both in one PATCH. */
  @IsOptional()
  @IsIn(BROKER_PROVIDERS)
  tradingProvider?: BrokerProvider;
}
