import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CredentialsModule } from '../credentials/credentials.module';
import { CredentialsService } from '../credentials/credentials.service';
import { PrismaService } from '../prisma/prisma.service';
import { BROKER_GATEWAY, BrokerGateway } from './broker-gateway.interface';
import { OrderEventsService } from './order-events.service';
import { WebullBrokerGateway } from './webull/webull-broker.gateway';
import { WebullTokenStore } from './webull/webull-token-store';
import { WebullSessionController } from './webull-session.controller';

/**
 * Provides the Webull BrokerGateway under the BROKER_GATEWAY token
 * (docs/ARCHITECTURE.md §2/§7). There is no mock/demo gateway: market data
 * always comes from Webull; live vs practice only selects the live vs
 * paper-trading (sandbox) OpenAPI hosts.
 */
@Module({
  imports: [CredentialsModule],
  controllers: [WebullSessionController],
  providers: [
    OrderEventsService,
    WebullTokenStore,
    {
      provide: BROKER_GATEWAY,
      inject: [
        ConfigService,
        OrderEventsService,
        CredentialsService,
        PrismaService,
        WebullTokenStore,
      ],
      useFactory: (
        config: ConfigService,
        events: OrderEventsService,
        credentials: CredentialsService,
        prisma: PrismaService,
        tokenStore: WebullTokenStore,
      ): BrokerGateway => new WebullBrokerGateway(credentials, config, events, prisma, tokenStore),
    },
  ],
  exports: [BROKER_GATEWAY, OrderEventsService],
})
export class BrokerModule {}
