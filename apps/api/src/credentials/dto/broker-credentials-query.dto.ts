import { IsIn, IsOptional } from 'class-validator';
import { BrokerProvider, TradingMode } from '@0dtetrader/shared-types';

/** Query for the generic DELETE /me/broker-credentials. */
export class BrokerCredentialsQueryDto {
  @IsOptional()
  @IsIn(['webull', 'alpaca'])
  provider?: BrokerProvider;

  @IsOptional()
  @IsIn(['live', 'practice'])
  environment?: TradingMode;
}
