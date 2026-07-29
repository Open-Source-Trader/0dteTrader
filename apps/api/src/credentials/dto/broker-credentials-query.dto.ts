import { IsIn, IsOptional } from 'class-validator';
import { CredentialProvider, TradingMode } from '@0dtetrader/shared-types';

/** Query for the generic DELETE /me/broker-credentials. */
export class BrokerCredentialsQueryDto {
  @IsOptional()
  @IsIn(['webull', 'alpaca', 'tradier', 'snaptrade'])
  provider?: CredentialProvider;

  @IsOptional()
  @IsIn(['live', 'practice'])
  environment?: TradingMode;
}
