import { Controller, Inject, Post } from '@nestjs/common';
import {
  BrokerProvider,
  BrokerSessionRefreshed,
  WebullSessionRefreshed,
} from '@0dtetrader/shared-types';
import { AuthenticatedUser, CurrentUser } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { BROKER_GATEWAY, BrokerGateway } from './broker-gateway.interface';

/**
 * Mint a fresh broker access token for the caller's current trading mode
 * without re-entering credentials ("Reconnect" button in Profile). Delegates
 * to the user's provider gateway via the dispatching BROKER_GATEWAY token, so
 * Webull users get a token re-create while Alpaca users get a no-op.
 */

/** Legacy Webull-pinned route — kept so the mobile apps (Phase 3) keep
 *  working until they adopt the generic endpoint. */
@Controller('me/webull-session')
export class WebullSessionController {
  constructor(@Inject(BROKER_GATEWAY) private readonly gateway: BrokerGateway) {}

  @Post('refresh')
  async refresh(@CurrentUser() user: AuthenticatedUser): Promise<WebullSessionRefreshed> {
    const environment = await this.gateway.reauthenticate(user.userId);
    return { refreshed: true, environment };
  }
}

/** Generic provider-agnostic session refresh (replaces the Webull-pinned
 *  route once mobile adopts it in Phase 3). Reports which provider was
 *  refreshed via the user's stored tradingProvider. */
@Controller('me/broker-session')
export class BrokerSessionController {
  constructor(
    @Inject(BROKER_GATEWAY) private readonly gateway: BrokerGateway,
    private readonly prisma: PrismaService,
  ) {}

  @Post('refresh')
  async refresh(@CurrentUser() user: AuthenticatedUser): Promise<BrokerSessionRefreshed> {
    const environment = await this.gateway.reauthenticate(user.userId);
    const record = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { tradingProvider: true },
    });
    return {
      provider: (record?.tradingProvider ?? 'webull') as BrokerProvider,
      refreshed: true,
      environment,
    };
  }
}
