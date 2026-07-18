import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { CandleInterval } from '@0dtetrader/shared-types';

export class QuoteQueryDto {
  @IsString()
  @Matches(/^[A-Za-z0-9.]{1,20}$/)
  symbol!: string;
}

export class CandlesQueryDto {
  @IsString()
  @Matches(/^[A-Za-z0-9.]{1,20}$/)
  symbol!: string;

  @IsIn(['1m', '5m', '15m', '1h', '1d'])
  interval!: CandleInterval;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class OptionsChainQueryDto {
  @IsString()
  @Matches(/^[A-Za-z0-9.]{1,12}$/)
  symbol!: string;

  @IsOptional()
  @IsDateString()
  expiration?: string;
}
