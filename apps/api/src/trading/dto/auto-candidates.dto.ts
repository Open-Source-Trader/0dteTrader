import { ValidationPipe } from '@nestjs/common';
import { IsDateString, IsIn, IsString, Matches } from 'class-validator';

export const AUTO_CANDIDATES_VALIDATION_PIPE = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  stopAtFirstError: false,
});

export class AutoCandidatesDto {
  @IsString()
  @Matches(/^[A-Za-z0-9.]{1,12}$/)
  underlying!: string;

  @IsDateString({ strict: true })
  expiration!: string;

  @IsIn(['call', 'put'])
  optionType!: 'call' | 'put';
}
