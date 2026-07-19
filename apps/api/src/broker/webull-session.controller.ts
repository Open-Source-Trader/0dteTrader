import { Controller, Inject, Post } from '@nestjs/common';
import { WebullSessionRefreshed } from '@0dtetrader/shared-types';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../common/current-user.decorator';
import { BROKER_GATEWAY, BrokerGateway } from './broker-gateway.interface';

@Controller('me/webull-session')
export class WebullSessionController {
  constructor(
    @Inject(BROKER_GATEWAY) private readonly gateway: BrokerGateway,
  ) {}

  /**
   * Mint a fresh Webull access token for the caller's current trading mode
   * without re-entering credentials ("Reconnect" button in Profile).
   */
  @Post('refresh')
  async refresh(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WebullSessionRefreshed> {
    const environment = await this.gateway.reauthenticate(user.userId);
    return { refreshed: true, environment };
  }
}
