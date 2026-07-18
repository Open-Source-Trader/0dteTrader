import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CredentialsModule } from '../credentials/credentials.module';
import { CredentialsService } from '../credentials/credentials.service';
import { BROKER_GATEWAY, BrokerGateway } from './broker-gateway.interface';
import { MockBrokerGateway } from './mock-broker.gateway';
import { OrderEventsService } from './order-events.service';
import { WebullBrokerGateway } from './webull/webull-broker.gateway';

/**
 * Provides the active BrokerGateway under the BROKER_GATEWAY token, selected
 * by the BROKER_GATEWAY env var (mock default; docs/ARCHITECTURE.md §2/§7).
 */
@Module({
  imports: [CredentialsModule],
  providers: [
    OrderEventsService,
    {
      provide: BROKER_GATEWAY,
      inject: [ConfigService, OrderEventsService, CredentialsService],
      useFactory: (
        config: ConfigService,
        events: OrderEventsService,
        credentials: CredentialsService,
      ): BrokerGateway =>
        config.get<'mock' | 'webull'>('brokerGateway') === 'webull'
          ? new WebullBrokerGateway(credentials, config, events)
          : new MockBrokerGateway(events),
    },
  ],
  exports: [BROKER_GATEWAY, OrderEventsService],
})
export class BrokerModule {}
