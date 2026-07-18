import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  AssetClass,
  OptionType,
  OrderSide,
  OrderType,
  SelectionMode,
} from '@0dtetrader/shared-types';

export class OrderSelectionDto {
  @IsIn(['auto_otm', 'explicit'])
  mode!: SelectionMode;

  @IsOptional()
  @IsIn(['call', 'put'])
  optionType?: OptionType;

  /** YYYY-MM-DD; defaults to the nearest expiration. */
  @IsOptional()
  @IsDateString()
  expiration?: string;

  /** Explicit option orders only. */
  @IsOptional()
  @IsNumber()
  strike?: number;
}

export class OrderRequestDto {
  @IsString()
  @Matches(/^[A-Za-z0-9.]{1,12}$/)
  underlying!: string;

  @IsIn(['option'])
  assetClass!: AssetClass;

  @IsIn(['buy', 'sell'])
  side!: OrderSide;

  @IsInt()
  @Min(1)
  @Max(1000)
  quantity!: number;

  @IsIn(['mid', 'market'])
  orderType!: OrderType;

  @ValidateNested()
  @Type(() => OrderSelectionDto)
  selection!: OrderSelectionDto;
}
