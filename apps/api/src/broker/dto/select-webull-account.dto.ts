import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { TradingMode } from '@0dtetrader/shared-types';

export class SelectWebullAccountDto {
  @IsString()
  @MinLength(1)
  accountId!: string;

  @IsOptional()
  @IsIn(['live', 'practice'])
  environment?: TradingMode;
}
