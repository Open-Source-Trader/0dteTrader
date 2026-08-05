import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Subscription } from 'rxjs';
import { ChartOrder, OrderResult, OrderStatus } from '@0dtetrader/shared-types';
import { isUniqueViolation } from '../common/api-exception';
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
 * Those buses do not cross processes, and the same outcome legitimately
 * reaches more than one of them: a SnapTrade fill arrives as two webhook
 * kinds load-balanced across instances (and SnapTrade retries a webhook it
 * thinks was lost), and a cancel served by any instance emits a synthetic
 * terminal status while the placing instance's poll emits its own. Delivery
 * is therefore deduped in the database — an insert-to-claim on (userId, key)
 * before the send, keyed only on what every emitter reports identically.
 *
 * The claim is per user+event, not per device token, so a device whose send
 * failed is not retried unless NO device took the push. That is the intended
 * trade: push is not the system of record (the fill is persisted regardless,
 * and the WebSocket stream carries the same update), while a duplicate "Order
 * filled" seconds apart reads as two fills and can prompt a wrong trade.
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
      // SnapTrade can report a trade update with no brokerage order id (it
      // maps to ''), which is no identity to dedupe on. Push it unkeyed
      // rather than claiming `order::filled`, which one such event would
      // hold forever and use to suppress every later id-less fill for this
      // user. At worst that fill is announced twice.
      order.orderId === '' ? null : `order:${order.orderId}:${order.status}`,
      titles[order.status] as string,
      `${order.side.toUpperCase()} ${order.quantity} ${order.contractSymbol}${price}`,
      async () => {
        // findFirst scoped by owner, not findUnique by id alone: the row's
        // primary key is the BROKER's order id, which is only unique within a
        // brokerage account — another user's identically-numbered order must
        // never decide this push's live/practice label.
        const row = await this.prisma.tradeOrder.findFirst({
          where: { id: order.orderId, userId },
        });
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
      // A line's fire is already claimed in the database before it emits, so
      // this key is for uniformity and for same-instance redelivery rather
      // than a reachable cross-instance duplicate. `triggered` then `failed`
      // are two genuinely different alerts, which is why status is in it.
      `chartorder:${order.id}:${order.status}`,
      title,
      `${order.side.toUpperCase()} ${order.quantity} ${order.contractSymbol} — ` +
        `${order.underlying} crossed ${order.triggerPrice}`,
      async () => {
        const row = await this.prisma.chartOrder.findFirst({ where: { id: order.id, userId } });
        return row?.environment ?? null;
      },
    );
  }

  private async notify(
    userId: string,
    /** Stable identity of the notifiable event, unique per user. Null when
     *  the event carries no id to key on — see handleOrderUpdate. */
    key: string | null,
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
    // Claimed as late as possible: after the no-devices check, so a fill
    // arriving before the user registers anything does not claim a key it
    // never delivered; and after the environment lookup, so a database error
    // there cannot leave a claim standing for a push that was never sent.
    // Everything past this point is the send itself, which never throws.
    let claimId: string | null = null;
    if (key !== null) {
      try {
        claimId = (await this.prisma.pushDelivery.create({ data: { userId, key } })).id;
      } catch (err) {
        if (isUniqueViolation(err)) return;
        throw err;
      }
    }
    const fullTitle = environment === 'practice' ? `PRACTICE · ${title}` : title;
    let delivered = false;
    try {
      // Concurrently: the loop body shares no state across devices, and a
      // sequential walk made the worst case one request timeout PER device.
      const results = await Promise.all(
        tokens.map(async (device) => ({
          device,
          result: await this.apns.send(device.token, { title: fullTitle, body }),
        })),
      );
      for (const { device, result } of results) {
        if (result.status === 200) {
          delivered = true;
        } else if (isDeadToken(result)) {
          await this.devices.prune(device.token);
        } else {
          this.logger.warn(
            `APNs send failed (${result.status}${result.reason ? ` ${result.reason}` : ''})`,
          );
        }
      }
    } finally {
      // Nothing reached a device: release the claim so the other emitter's
      // next report — or the webhook retry — can try again. Without this the
      // dedupe would turn the very race it exists to fix into a missed
      // alert. In a `finally` because a throw on the way out (a prune
      // failing, say) must not leave a claim standing for a push nobody
      // received. Deliberately kept on PARTIAL success: a device that
      // already showed the alert must not show it twice.
      //
      // A process death between the claim and the send still suppresses that
      // alert permanently; closing that needs per-device delivery state
      // rather than a boolean claim.
      if (claimId !== null && !delivered) {
        await this.prisma.pushDelivery.deleteMany({ where: { id: claimId } });
      }
    }
  }
}
