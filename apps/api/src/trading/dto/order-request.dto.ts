import { Type } from 'class-transformer';
import {
  IsDateString,
  Equals,
  IsBoolean,
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
  MAX_ORDER_QUANTITY,
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

function IsValidSelectionShape(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isValidSelectionShape',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(_value: unknown, args: ValidationArguments): boolean {
          const selection = args.object as OrderSelectionDto;
          const hasLegacyOffset = 'otmOffset' in selection;
          if (selection.mode === 'auto_scored') {
            return (
              !hasLegacyOffset &&
              selection.autoScoring !== undefined &&
              selection.strike === undefined &&
              selection.classicFallbackAcknowledged === undefined
            );
          }
          if (selection.mode === 'explicit') {
            return (
              !hasLegacyOffset &&
              selection.strike !== undefined &&
              selection.autoScoring === undefined &&
              selection.classicFallbackAcknowledged === undefined
            );
          }
          return (
            !hasLegacyOffset &&
            selection.mode === 'auto_otm' &&
            selection.autoScoring === undefined &&
            selection.strike === undefined
          );
        },
        defaultMessage(): string {
          return 'selection fields do not match mode; autoScoring is required only for auto_scored and strike only for explicit';
        },
      },
    });
  };
}

function HasPositiveWeightTotal(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'hasPositiveWeightTotal',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(_value: unknown, args: ValidationArguments): boolean {
          const weights = args.object as AutoScoringWeightsDto;
          return (
            weights.delta + weights.spread + weights.openInterest + weights.gamma + weights.iv > 0
          );
        },
        defaultMessage(): string {
          return 'Auto scoring weights must have a positive total';
        },
      },
    });
  };
}

export class AutoScoringWeightsDto {
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  delta!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  spread!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  openInterest!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  gamma!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  @HasPositiveWeightTotal()
  iv!: number;
}

export class AutoScoringPreferencesDto {
  @Equals(1)
  schemaVersion!: 1;

  @IsIn(['conservative', 'aggressive', 'custom'])
  preset!: 'conservative' | 'aggressive' | 'custom';

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(0.99)
  targetAbsDelta!: number;

  @IsInt()
  @Min(0)
  @Max(20)
  strikeRungs!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(10_000)
  maxSpreadBps!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(Number.MIN_VALUE)
  @Max(1_000_000)
  maxPremiumDollars!: number;

  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  minOpenInterest!: number;

  @IsIn(['seek', 'avoid'])
  gammaMode!: 'seek' | 'avoid';

  @ValidateNested()
  @Type(() => AutoScoringWeightsDto)
  weights!: AutoScoringWeightsDto;
}

export class AutoScoringSelectionDto {
  @IsString()
  @Matches(/^[A-Z0-9.]{6,32}$/)
  selectedSymbol!: string;

  @ValidateNested()
  @Type(() => AutoScoringPreferencesDto)
  preferences!: AutoScoringPreferencesDto;

  @Equals(true, { message: 'scored confirmation must be explicitly accepted' })
  scoredConfirmationAccepted!: true;

  @IsDateString()
  rankedAt!: string;
}

export class OrderSelectionDto {
  @IsIn(['auto_otm', 'auto_scored', 'explicit'])
  @IsValidSelectionShape()
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

  @IsOptional()
  @IsBoolean()
  classicFallbackAcknowledged?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => AutoScoringSelectionDto)
  autoScoring?: AutoScoringSelectionDto;
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
  @Max(MAX_ORDER_QUANTITY)
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
