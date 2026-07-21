import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CredentialsModule } from '../credentials/credentials.module';
import { CredentialsService } from '../credentials/credentials.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  BROKER_GATEWAY,
  BrokerGateway,
  MARKET_DATA_PROVIDER,
  MarketDataProvider,
} from './broker-gateway.interface';
import { OrderEventsService } from './order-events.service';
import { AlpacaBrokerGateway } from './alpaca/alpaca-broker.gateway';
import { DispatchingBrokerGateway } from './dispatching-broker.gateway';
import { WebullBrokerGateway } from './webull/webull-broker.gateway';
import { WebullTokenStore } from './webull/webull-token-store';
import { SnapTradeClient } from './snaptrade/snaptrade-client';
import { SnapTradeBrokerGateway } from './snaptrade/snaptrade-broker.gateway';
import { SnapTradeConnectionService } from './snaptrade/snaptrade-connection.service';
import { SnapTradeConnectionController } from './snaptrade/snaptrade-session.controller';
import { SnapTradeWebhookController } from './snaptrade/snaptrade-webhook.controller';
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
    SnapTradeConnectionController,
    SnapTradeWebhookController,
  ],
  providers: [
    OrderEventsService,
    WebullTokenStore,
    SnapTradeClient,
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
    // SnapTrade gateway: handles execution + account data via SnapTrade SDK.
    // Market-data methods are forwarded to the injected MarketDataProvider
    // (resolves to Webull or Alpaca depending on the legacy provider binding).
    {
      provide: SnapTradeBrokerGateway,
      inject: [
        SnapTradeClient,
        CredentialsService,
        OrderEventsService,
        PrismaService,
        MARKET_DATA_PROVIDER,
      ],
      useFactory: (
        client: SnapTradeClient,
        credentials: CredentialsService,
        prisma: PrismaService,
        events: OrderEventsService,
        marketData: MarketDataProvider,
      ): SnapTradeBrokerGateway =>
        new SnapTradeBrokerGateway(client, credentials, prisma, events, marketData),
    },
    // SnapTrade connection lifecycle (register, authorize, list, select, etc.).
    SnapTradeConnectionService,
    // MarketDataProvider token: the SnapTrade gateway injects this
    // and forwards market-data calls to it. Today it is bound to Webull
    // (the default legacy provider); in a follow-up it can be resolved
    // per-user based on configured legacy credentials.
    {
      provide: MARKET_DATA_PROVIDER,
      inject: [WebullBrokerGateway],
      useFactory: (webull: WebullBrokerGateway): MarketDataProvider => webull,
    },
    {
      provide: BROKER_GATEWAY,
      inject: [PrismaService, WebullBrokerGateway, AlpacaBrokerGateway, SnapTradeBrokerGateway],
      useFactory: (
        prisma: PrismaService,
        webull: WebullBrokerGateway,
        alpaca: AlpacaBrokerGateway,
        snaptrade: SnapTradeBrokerGateway,
      ): BrokerGateway => new DispatchingBrokerGateway(prisma, webull, alpaca, snaptrade),
    },
  ],
  exports: [BROKER_GATEWAY, OrderEventsService],
})
export class BrokerModule {}
