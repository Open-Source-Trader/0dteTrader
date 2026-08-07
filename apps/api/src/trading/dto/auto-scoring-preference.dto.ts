import { ValidationPipe } from '@nestjs/common';
import { Equals, IsDateString, IsIn, IsInt, IsNumber, IsPositive, Max, Min } from 'class-validator';

export const AUTO_PREFERENCE_VALIDATION_PIPE = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  stopAtFirstError: false,
});

export class AutoScoringPreferenceCreateDto {
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
  @IsPositive()
  @Max(1_000_000)
  maxPremiumDollars!: number;

  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  minOpenInterest!: number;

  @IsIn(['seek', 'avoid'])
  gammaMode!: 'seek' | 'avoid';

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  deltaWeight!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  spreadWeight!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  openInterestWeight!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  gammaWeight!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  ivWeight!: number;
}

export class AutoScoringPreferenceUpdateDto extends AutoScoringPreferenceCreateDto {
  @IsDateString({}, { message: 'expectedUpdatedAt must be an ISO-8601 timestamp' })
  expectedUpdatedAt!: string;
}
