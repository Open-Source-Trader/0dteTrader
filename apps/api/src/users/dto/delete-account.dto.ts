import { IsEmail } from 'class-validator';

export class DeleteAccountDto {
  @IsEmail()
  confirmEmail!: string;
}
