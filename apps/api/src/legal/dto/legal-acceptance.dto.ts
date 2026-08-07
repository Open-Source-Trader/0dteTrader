import { IsIn, IsString } from 'class-validator';

export class LegalAcceptanceDto {
  @IsIn(['terms', 'risk'])
  document!: 'terms' | 'risk';

  @IsString()
  version!: string;
}
