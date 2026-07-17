import { IsString, MinLength } from 'class-validator';

export class WebullCredentialsDto {
  @IsString()
  @MinLength(1)
  appKey!: string;

  @IsString()
  @MinLength(1)
  appSecret!: string;

  @IsString()
  @MinLength(1)
  accountId!: string;
}
