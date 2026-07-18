import { IsIn } from 'class-validator';
import { TradingMode } from '@0dtetrader/shared-types';

export class UpdateMeDto {
  @IsIn(['live', 'practice'])
  tradingMode!: TradingMode;
}
