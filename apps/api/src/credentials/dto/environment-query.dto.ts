import { IsIn, IsOptional } from 'class-validator';
import { TradingMode } from '@0dtetrader/shared-types';

export class EnvironmentQueryDto {
  @IsOptional()
  @IsIn(['live', 'practice'])
  environment?: TradingMode;
}
