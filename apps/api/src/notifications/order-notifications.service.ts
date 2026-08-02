import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Subscription } from 'rxjs';
import { ChartOrder, OrderResult, OrderStatus } from '@0dtetrader/shared-types';
import { OrderEventsService } from '../broker/order-events.service';
import { ChartOrderEventsService } from '../chart-orders/chart-order-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { ApnsClient, isDeadToken } from './apns.client';
import { DevicesService } from './devices.service';

const TERMINAL_ORDER_STATUSES = new Set<OrderStatus>(['filled', 'rejected', 'cancelled']);

/**
 * Pushes order outcomes to the user's registered devices, subscribing to the
 * same in-process buses the WebSocket gateway and OrdersService already ride.
 *
 * Multi-instance note: these buses do not cross processes — but the instance
 * that runs the broker status poll (or holds the chart-order watcher lease) is
 * the one that emits the event, so each event pushes exactly once today. If
 * events ever move to a shared bus, this subscriber needs a dedupe story.
 */
@Injectable()
export class OrderNotificationsService implements OnModuleDestroy {
  private readonly logger = new Logger(OrderNotificationsService.name);
  private readonly subs: Subscription[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly devices: DevicesService,
    private readonly apns: ApnsClient,
    orderEvents: OrderEventsService,
    chartOrderEvents: ChartOrderEventsService,
  ) {
    this.subs = [
      orderEvents.events$.subscribe((event) => {
        void this.handleOrderUpdate(event.userId, event.order).catch((err) =>
          this.logger.warn(`order push failed: ${(err as Error).message}`),
        );
      }),
      chartOrderEvents.events$.subscribe((event) => {
        void this.handleChartOrder(event.userId, event.order).catch((err) =>
          this.logger.warn(`chart-order push failed: ${(err as Error).message}`),
        );
      }),
    ];
  }

  onModuleDestroy(): void {
    for (const sub of this.subs) sub.unsubscribe();
  }

  /** Terminal statuses only — nobody needs a push for `submitted`. */
  async handleOrderUpdate(userId: string, order: OrderResult): Promise<void> {
    if (!this.apns.enabled) return;
    if (!TERMINAL_ORDER_STATUSES.has(order.status)) return;
    const titles: Partial<Record<OrderStatus, string>> = {
      filled: 'Order filled',
      rejected: 'Order rejected',
      cancelled: 'Order cancelled',
    };
    const price = order.filledPrice !== undefined ? ` @ ${order.filledPrice}` : '';
    await this.notify(
      userId,
      titles[order.status] as string,
      `${order.side.toUpperCase()} ${order.quantity} ${order.contractSymbol}${price}`,
      async () => {
        const row = await this.prisma.tradeOrder.findUnique({ where: { id: order.orderId } });
        return row?.environment ?? null;
      },
    );
  }

  /** A line firing (or failing to) is exactly the unattended case push exists for. */
  async handleChartOrder(userId: string, order: ChartOrder): Promise<void> {
    if (!this.apns.enabled) return;
    if (order.status !== 'triggered' && order.status !== 'failed') return;
    const title = order.status === 'triggered' ? 'Chart order fired' : 'Chart order failed';
    await this.notify(
      userId,
      title,
      `${order.side.toUpperCase()} ${order.quantity} ${order.contractSymbol} — ` +
        `${order.underlying} crossed ${order.triggerPrice}`,
      async () => {
        const row = await this.prisma.chartOrder.findUnique({ where: { id: order.id } });
        return row?.environment ?? null;
      },
    );
  }

  private async notify(
    userId: string,
    title: string,
    body: string,
    /** The environment stamped on the persisted order — immutable, unlike the
     *  user's current mode. A live fill pushed after switching to practice
     *  (or vice versa) must wear the label of the account it traded in. */
    recordedEnvironment: () => Promise<string | null>,
  ): Promise<void> {
    const tokens = await this.devices.listForUser(userId);
    if (tokens.length === 0) return;
    let environment = await recordedEnvironment();
    if (environment === null) {
      // The row may not be written yet (this subscriber and the persister ride
      // the same bus); the user's current mode is the closest answer left.
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      environment = user?.tradingMode === 'practice' ? 'practice' : 'live';
    }
    const fullTitle = environment === 'practice' ? `PRACTICE · ${title}` : title;
    for (const device of tokens) {
      const result = await this.apns.send(device.token, { title: fullTitle, body });
      if (isDeadToken(result)) {
        await this.devices.prune(device.token);
      } else if (result.status !== 200) {
        this.logger.warn(
          `APNs send failed (${result.status}${result.reason ? ` ${result.reason}` : ''})`,
        );
      }
    }
  }
}
