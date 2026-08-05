import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Subscription } from 'rxjs';
import { ChartOrder, OrderResult, OrderStatus, TradingMode } from '@0dtetrader/shared-types';
import { isUniqueViolation } from '../common/api-exception';
import { OrderEventsService, OrderUpdateEvent } from '../broker/order-events.service';
import { ChartOrderEventsService } from '../chart-orders/chart-order-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { ApnsClient, isDeadToken } from './apns.client';
import { DevicesService } from './devices.service';

const TERMINAL_ORDER_STATUSES = new Set<OrderStatus>(['filled', 'rejected', 'cancelled']);
const WORKER_INTERVAL_MS = 500;
const LEASE_MS = 30_000;
const MAX_ATTEMPTS = 5;
const RETENTION_MS = 7 * 24 * 60 * 60_000;

/**
 * Durable, per-device APNs outbox.
 *
 * Event handlers only create delivery rows. Any API instance may then claim a
 * due row with a compare-and-set lease. A successful sibling never masks a
 * failed device: every token owns its own status, retry schedule and terminal
 * outcome.
 */
@Injectable()
export class OrderNotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderNotificationsService.name);
  private readonly ownerId = randomUUID();
  private readonly subs: Subscription[];
  private timer: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly devices: DevicesService,
    private readonly apns: ApnsClient,
    orderEvents: OrderEventsService,
    chartOrderEvents: ChartOrderEventsService,
  ) {
    this.subs = [
      orderEvents.events$.subscribe((event) => {
        void this.handleOrderUpdate(event.userId, event.order, event.environment, event).catch(
          (error) => this.logger.warn(`order push enqueue failed: ${(error as Error).message}`),
        );
      }),
      chartOrderEvents.events$.subscribe((event) => {
        void this.handleChartOrder(event.userId, event.order).catch((error) =>
          this.logger.warn(`chart-order push enqueue failed: ${(error as Error).message}`),
        );
      }),
    ];
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.processDue(), WORKER_INTERVAL_MS);
    this.timer.unref?.();
    void this.processDue();
  }

  onModuleDestroy(): void {
    for (const sub of this.subs) sub.unsubscribe();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async handleOrderUpdate(
    userId: string,
    order: OrderResult,
    environment?: TradingMode,
    identity: Pick<
      OrderUpdateEvent,
      'provider' | 'accountId' | 'brokerOrderId' | 'clientOrderId'
    > = {},
  ): Promise<void> {
    if (!this.apns.enabled || !TERMINAL_ORDER_STATUSES.has(order.status)) return;
    const titles: Partial<Record<OrderStatus, string>> = {
      filled: 'Order filled',
      rejected: 'Order rejected',
      cancelled: 'Order cancelled',
    };
    const price = order.filledPrice !== undefined ? ` @ ${order.filledPrice}` : '';
    await this.enqueue(
      userId,
      order.orderId === ''
        ? `unidentified:${randomUUID()}`
        : [
            'order',
            identity.provider ?? 'legacy',
            environment ?? 'unknown',
            identity.accountId ?? 'default',
            identity.clientOrderId ?? identity.brokerOrderId ?? order.orderId,
            order.status,
          ].join(':'),
      titles[order.status] as string,
      `${order.side.toUpperCase()} ${order.quantity} ${order.contractSymbol}${price}`,
      async () => {
        if (environment) return environment;
        const row = await this.prisma.tradeOrder.findFirst({
          where: {
            userId,
            OR: [
              { id: order.orderId },
              { brokerOrderId: order.orderId },
              { clientOrderId: order.orderId },
            ],
          },
        });
        return row?.environment ?? null;
      },
    );
    await this.processDue();
  }

  async handleChartOrder(userId: string, order: ChartOrder): Promise<void> {
    if (!this.apns.enabled) return;
    if (order.status !== 'triggered' && order.status !== 'failed') return;
    const title = order.status === 'triggered' ? 'Chart order fired' : 'Chart order failed';
    await this.enqueue(
      userId,
      `chartorder:${order.id}:${order.status}`,
      title,
      `${order.side.toUpperCase()} ${order.quantity} ${order.contractSymbol} — ` +
        `${order.underlying} crossed ${order.triggerPrice}`,
      async () => {
        const row = await this.prisma.chartOrder.findFirst({ where: { id: order.id, userId } });
        return row?.environment ?? null;
      },
    );
    await this.processDue();
  }

  private async enqueue(
    userId: string,
    key: string,
    title: string,
    body: string,
    recordedEnvironment: () => Promise<string | null>,
  ): Promise<void> {
    const tokens = await this.devices.listForUser(userId);
    if (tokens.length === 0) return;
    let environment = await recordedEnvironment();
    if (environment === null) {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      environment = user?.tradingMode === 'practice' ? 'practice' : 'live';
    }
    const fullTitle = environment === 'practice' ? `PRACTICE · ${title}` : title;
    for (const device of tokens) {
      try {
        await this.prisma.pushDelivery.create({
          data: {
            userId,
            key,
            deviceToken: device.token,
            environment,
            title: fullTitle,
            body,
          },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
  }

  /** Claims and processes all currently due rows. Public for deterministic
   * two-instance and crash-recovery tests. */
  async processDue(now = new Date()): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.runRetention(now);
      // Retention is database maintenance and must run even in deployments
      // where APNs delivery is intentionally disabled.
      if (!this.apns.enabled) return;
      for (;;) {
        const candidate = await this.prisma.pushDelivery.findFirst({
          where: this.dueWhere(now),
          orderBy: { createdAt: 'asc' },
        });
        if (!candidate) break;
        const attempts = candidate.attempts + 1;
        const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
        const claimed = await this.prisma.pushDelivery.updateMany({
          where: { id: candidate.id, ...this.dueWhere(now) },
          data: {
            status: 'leased',
            attempts,
            leaseOwnerId: this.ownerId,
            leaseExpiresAt,
          },
        });
        if (claimed.count !== 1) continue;
        await this.deliver(
          candidate.id,
          candidate.deviceToken,
          candidate.title,
          candidate.body,
          attempts,
          now,
        );
      }
    } finally {
      this.draining = false;
    }
  }

  private dueWhere(now: Date) {
    return {
      OR: [
        { status: { in: ['pending', 'retry'] }, nextAttemptAt: { lte: now } },
        { status: 'leased', leaseExpiresAt: { lt: now } },
      ],
    };
  }

  private async deliver(
    id: string,
    token: string,
    title: string,
    body: string,
    attempts: number,
    now: Date,
  ): Promise<void> {
    const result = await this.apns.send(token, { title, body });
    const owned = { id, status: 'leased', leaseOwnerId: this.ownerId };
    if (result.status === 200) {
      await this.prisma.pushDelivery.updateMany({
        where: owned,
        data: {
          status: 'delivered',
          deliveredAt: now,
          leaseOwnerId: null,
          leaseExpiresAt: null,
          lastError: null,
        },
      });
      return;
    }
    const reason = `${result.status}${result.reason ? ` ${result.reason}` : ''}`;
    if (isDeadToken(result)) {
      await this.prisma.pushDelivery.updateMany({
        where: owned,
        data: {
          status: 'dead',
          leaseOwnerId: null,
          leaseExpiresAt: null,
          lastError: reason,
        },
      });
      try {
        await this.devices.prune(token);
      } catch (error) {
        this.logger.warn(`dead-token prune failed: ${(error as Error).message}`);
      }
      return;
    }
    const terminal = attempts >= MAX_ATTEMPTS;
    await this.prisma.pushDelivery.updateMany({
      where: owned,
      data: {
        status: terminal ? 'dead' : 'retry',
        nextAttemptAt: new Date(now.getTime() + this.backoffMs(attempts)),
        leaseOwnerId: null,
        leaseExpiresAt: null,
        lastError: reason,
      },
    });
    this.logger.warn(`APNs delivery ${id} failed (${reason}); ${terminal ? 'dead' : 'retrying'}`);
  }

  private backoffMs(attempts: number): number {
    return Math.min(60 * 60_000, 1_000 * 2 ** Math.max(0, attempts - 1));
  }

  private async runRetention(now: Date): Promise<void> {
    const leaseName = `push-delivery-retention:${now.toISOString().slice(0, 10)}`;
    const workLeaseExpiresAt = new Date(now.getTime() + 5 * 60_000);
    let claimed = await this.prisma.scheduledJobLease.updateMany({
      where: { name: leaseName, expiresAt: { lt: now } },
      data: { ownerId: this.ownerId, expiresAt: workLeaseExpiresAt },
    });
    if (claimed.count !== 1) {
      try {
        await this.prisma.scheduledJobLease.create({
          data: { name: leaseName, ownerId: this.ownerId, expiresAt: workLeaseExpiresAt },
        });
        claimed = { count: 1 };
      } catch (error) {
        if (isUniqueViolation(error)) return;
        throw error;
      }
    }
    try {
      await this.prisma.pushDelivery.deleteMany({
        where: {
          status: { in: ['delivered', 'dead'] },
          createdAt: { lt: new Date(now.getTime() - RETENTION_MS) },
        },
      });
      await this.prisma.scheduledJobLease.updateMany({
        where: { name: leaseName, ownerId: this.ownerId },
        data: { expiresAt: new Date(now.getTime() + 25 * 60 * 60_000) },
      });
    } catch (error) {
      // Let another tick retry today's sweep after a transient database
      // failure instead of treating the failed attempt as completed all day.
      await this.prisma.scheduledJobLease
        .updateMany({
          where: { name: leaseName, ownerId: this.ownerId },
          data: { expiresAt: now },
        })
        .catch(() => undefined);
      throw error;
    }
  }
}
