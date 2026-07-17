import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CredentialsModule } from '../credentials/credentials.module';
import { BROKER_GATEWAY, BrokerGateway } from './broker-gateway.interface';
import { MockBrokerGateway } from './mock-broker.gateway';
import { OrderEventsService } from './order-events.service';
import { WebullBrokerGateway } from './webull-broker.gateway';
import { WebullClientProvider } from './webull/webull-client.provider';
import { WebullHttpClient } from './webull/webull-http.client';
import { WebullTokenStore } from './webull/webull-token.store';

/**
 * Provides the active BrokerGateway under the BROKER_GATEWAY token, selected
 * by the BROKER_GATEWAY env var (mock default; docs/ARCHITECTURE.md §2/§7).
 */
@Module({
  imports: [CredentialsModule],
  providers: [
    OrderEventsService,
    WebullHttpClient,
    WebullTokenStore,
    WebullClientProvider,
    {
      provide: BROKER_GATEWAY,
      inject: [ConfigService, OrderEventsService, WebullClientProvider],
      useFactory: (
        config: ConfigService,
        events: OrderEventsService,
        webullClient: WebullClientProvider,
      ): BrokerGateway =>
        config.get<'mock' | 'webull'>('brokerGateway') === 'webull'
          ? new WebullBrokerGateway(webullClient, events)
          : new MockBrokerGateway(events),
    },
  ],
  exports: [BROKER_GATEWAY, OrderEventsService],
})
export class BrokerModule {}
