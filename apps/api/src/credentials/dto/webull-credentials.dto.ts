import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { TradingMode } from '@0dtetrader/shared-types';

export class WebullCredentialsDto {
  @IsString()
  @MinLength(1)
  appKey!: string;

  @IsString()
  @MinLength(1)
  appSecret!: string;

  /** Optional manual override; normally auto-discovered via account/list. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  accountId?: string;

  @IsOptional()
  @IsIn(['live', 'practice'])
  environment?: TradingMode;
}
