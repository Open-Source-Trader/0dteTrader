import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ChartOrderKind, OptionType, OrderSide, OrderType } from '@0dtetrader/shared-types';

/**
 * Create payload for a chart order line. The server re-resolves the contract,
 * reads the arm price from a live quote, and derives the expiry itself — the
 * client's strike is advisory, exactly as it is for a normal order
 * (docs/SECURITY.md §4.2).
 */
export class CreateChartOrderDto {
  @IsString()
  @Matches(/^[A-Za-z0-9.]{1,12}$/)
  underlying!: string;

  @IsNumber()
  @IsPositive()
  triggerPrice!: number;

  @IsIn(['buy', 'sell'])
  side!: OrderSide;

  @IsInt()
  @Min(1)
  @Max(1000)
  quantity!: number;

  @IsIn(['mid', 'market'])
  orderType!: OrderType;

  @IsIn(['limit', 'target', 'stop'])
  kind!: ChartOrderKind;

  @IsIn(['call', 'put'])
  optionType!: OptionType;

  /** YYYY-MM-DD. */
  @IsDateString()
  expiration!: string;

  @IsNumber()
  @IsPositive()
  strike!: number;

  /** Set to bracket this line with an existing one (target ↔ stop). */
  @IsOptional()
  @IsUUID()
  ocoGroupId?: string;
}

/** Edit payload. Only `working` lines accept it; every field is optional. */
export class UpdateChartOrderDto {
  @IsOptional()
  @IsNumber()
  @IsPositive()
  triggerPrice?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  quantity?: number;

  @IsOptional()
  @IsIn(['mid', 'market'])
  orderType?: OrderType;
}
