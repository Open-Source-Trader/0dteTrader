import { IsIn, IsOptional } from 'class-validator';
import { BrokerProvider, TradingMode } from '@0dtetrader/shared-types';

export class UpdateMeDto {
  @IsOptional()
  @IsIn(['live', 'practice'])
  tradingMode?: TradingMode;

  /** Active trading provider. Optional so the same endpoint can flip the
   *  mode, the provider, or both in one PATCH. */
  @IsOptional()
  @IsIn(['webull', 'alpaca'])
  tradingProvider?: BrokerProvider;
}
