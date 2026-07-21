import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CredentialsModule } from '../credentials/credentials.module';
import { CredentialsService } from '../credentials/credentials.service';
import { PrismaService } from '../prisma/prisma.service';
import { BROKER_GATEWAY, BrokerGateway } from './broker-gateway.interface';
import { OrderEventsService } from './order-events.service';
import { AlpacaBrokerGateway } from './alpaca/alpaca-broker.gateway';
import { DispatchingBrokerGateway } from './dispatching-broker.gateway';
import { WebullBrokerGateway } from './webull/webull-broker.gateway';
import { WebullTokenStore } from './webull/webull-token-store';
import {
  CredentialsController,
  BrokerCredentialsController,
} from '../credentials/credentials.controller';
import { BrokerSessionController, WebullSessionController } from './webull-session.controller';

/**
 * Provides the BrokerGateway under the BROKER_GATEWAY token
 * (docs/ARCHITECTURE.md §2/§7). The token is a DispatchingBrokerGateway
 * that routes each call to the user's provider (Webull or Alpaca) based on
 * their `tradingProvider` (docs/plans/alpaca-provider-plan.md §Phase2). Both
 * gateways are self-contained providers; the dispatcher is transparent to the
 * consumers (trading.service, market-data.controller, stream.gateway).
 */
@Module({
  imports: [CredentialsModule],
  controllers: [
    WebullSessionController,
    BrokerSessionController,
    CredentialsController,
    BrokerCredentialsController,
  ],
  providers: [
    OrderEventsService,
    WebullTokenStore,
    // Webull gateway: token store + legacy account-id discovery (api key/secret).
    {
      provide: WebullBrokerGateway,
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
    // Alpaca gateway: backed by the official Alpaca SDK (it owns HTTP/endpoints).
    // The SDK selects hosts from the user's trading mode (paper vs live), so no
    // ConfigService is needed here.
    {
      provide: AlpacaBrokerGateway,
      inject: [CredentialsService, OrderEventsService, PrismaService],
      useFactory: (
        credentials: CredentialsService,
        events: OrderEventsService,
        prisma: PrismaService,
      ): AlpacaBrokerGateway => new AlpacaBrokerGateway(credentials, events, prisma),
    },
    // The BROKER_GATEWAY token: routes by tradingProvider.
    {
      provide: BROKER_GATEWAY,
      inject: [PrismaService, WebullBrokerGateway, AlpacaBrokerGateway],
      useFactory: (
        prisma: PrismaService,
        webull: WebullBrokerGateway,
        alpaca: AlpacaBrokerGateway,
      ): BrokerGateway => new DispatchingBrokerGateway(prisma, webull, alpaca),
    },
  ],
  exports: [BROKER_GATEWAY, OrderEventsService],
})
export class BrokerModule {}
