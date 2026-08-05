import { Module } from '@nestjs/common';
import { BrokerModule } from '../broker/broker.module';
import { ChartOrdersModule } from '../chart-orders/chart-orders.module';
import { CredentialsModule } from '../credentials/credentials.module';
import { TradingModule } from '../trading/trading.module';
import { ApnsClient } from './apns.client';
import { DevicesService } from './devices.service';
import { NotificationsController } from './notifications.controller';
import { OrderNotificationsService } from './order-notifications.service';
import { DiscordNotificationsService } from './discord-notifications.service';

/**
 * Push notifications: the device registry endpoints and the APNs subscriber
 * that turns order/chart-order events into pushes. Inert unless APNS_ENABLED
 * is set with a provisioned key.
 */
@Module({
  imports: [BrokerModule, ChartOrdersModule, CredentialsModule, TradingModule],
  controllers: [NotificationsController],
  providers: [ApnsClient, DevicesService, OrderNotificationsService, DiscordNotificationsService],
})
export class NotificationsModule {}
