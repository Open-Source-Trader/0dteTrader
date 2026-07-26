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
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import {
  AssetClass,
  OptionType,
  OrderSide,
  OrderType,
  SelectionMode,
} from '@0dtetrader/shared-types';
import { validateLimitPrice } from '../../broker/order-pricing';

/**
 * `limitPrice` against the request's own `orderType` — required for `custom`,
 * rejected otherwise, and bounded and tick-aligned when present.
 *
 * One decorator rather than a stack of them because the rule is a relationship
 * between two properties, and `@ValidateIf` gates every decorator on a property
 * together — it cannot express "required under this condition, forbidden under
 * that one" on the same field. The rule itself lives in `order-pricing.ts`,
 * where it is a pure function the gateways and the unit tests share.
 */
function IsValidLimitPrice(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isValidLimitPrice',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          return validateLimitPrice((args.object as OrderRequestDto).orderType, value) === null;
        },
        defaultMessage(args: ValidationArguments): string {
          return (
            validateLimitPrice((args.object as OrderRequestDto).orderType, args.value) ??
            'limitPrice is invalid'
          );
        },
      },
    });
  };
}

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

  @IsIn(['custom', 'bid', 'mid', 'ask', 'market'])
  orderType!: OrderType;

  /**
   * The price to work a `custom` limit at, in dollars per share.
   *
   * This is the only number on this request the server does not recompute for
   * itself, so it is the only one that needs real validation here — a public
   * endpoint cannot lean on the client's field having checked it.
   */
  @IsValidLimitPrice()
  limitPrice?: number;

  @ValidateNested()
  @Type(() => OrderSelectionDto)
  selection!: OrderSelectionDto;
}
