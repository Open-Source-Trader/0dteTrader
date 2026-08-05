import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
const TOKEN_TRANSACTION_TIMEOUT_MS = 30_000;
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
  private readonly chartSub: Subscription;
  private readonly unregisterIngestor: () => void;
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private lastRetentionDay: string | null = null;
  private retentionRetryAfter = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly devices: DevicesService,
    private readonly apns: ApnsClient,
    orderEvents: OrderEventsService,
    chartOrderEvents: ChartOrderEventsService,
  ) {
    // OrdersService persists at priority 100. This ingestor runs afterwards so
    // a webhook acknowledgement awaits both the canonical TradeOrder and every
    // per-device outbox row derived from its internal identity. APNs itself is
    // intentionally left to the worker after that durable handoff.
    this.unregisterIngestor = orderEvents.registerIngestor(async (event) => {
      await this.enqueueOrderUpdate(event.userId, event.order, event.environment, event);
      this.kickWorker();
    }, 50);
    this.chartSub = chartOrderEvents.events$.subscribe((event) => {
      void this.handleChartOrder(event.userId, event.order).catch((error) =>
        this.logger.warn(`chart-order push enqueue failed: ${(error as Error).message}`),
      );
    });
  }

  onModuleInit(): void {
    this.timer = setInterval(() => this.kickWorker(), WORKER_INTERVAL_MS);
    this.timer.unref?.();
    this.kickWorker();
  }

  onModuleDestroy(): void {
    this.unregisterIngestor();
    this.chartSub.unsubscribe();
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
    await this.enqueueOrderUpdate(userId, order, environment, identity);
    await this.processDue();
  }

  private async enqueueOrderUpdate(
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
    const aliases = Array.from(
      new Set(
        [identity.brokerOrderId, identity.clientOrderId, order.orderId]
          .map((value) => value?.trim())
          .filter((value): value is string => Boolean(value)),
      ),
    );
    const canonical = await this.canonicalOrder(userId, aliases, environment, identity);
    const knownAliases = Array.from(
      new Set(
        [canonical?.brokerOrderId, canonical?.clientOrderId, ...aliases].filter(
          (value): value is string => Boolean(value),
        ),
      ),
    );
    let key: string;
    if (canonical) {
      key = `order:${canonical.id}:${order.status}`;
    } else if (order.orderId === '') {
      key = `unidentified:${randomUUID()}`;
    } else {
      key = [
        'order',
        identity.provider ?? 'legacy',
        environment ?? 'unknown',
        identity.accountId ?? 'default',
        identity.clientOrderId ?? identity.brokerOrderId ?? order.orderId,
        order.status,
      ].join(':');
    }
    // Preserve aggregate claims from the pre-outbox schema, and also bridge
    // the scoped external-id keys emitted by the first per-device release.
    const aggregateLegacyKeys = knownAliases.map((alias) => `order:${alias}:${order.status}`);
    const priorScopedKeys = canonical
      ? knownAliases.map((alias) =>
          [
            'order',
            identity.provider ?? 'legacy',
            environment ?? 'unknown',
            identity.accountId ?? 'default',
            alias,
            order.status,
          ].join(':'),
        )
      : [];
    await this.enqueue(
      userId,
      key,
      titles[order.status] as string,
      `${order.side.toUpperCase()} ${order.quantity} ${order.contractSymbol}${price}`,
      async () => {
        if (environment) return environment;
        return canonical?.environment ?? null;
      },
      aggregateLegacyKeys,
      priorScopedKeys,
    );
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
      [`chartorder:${order.id}:${order.status}`],
    );
    await this.processDue();
  }

  private async enqueue(
    userId: string,
    key: string,
    title: string,
    body: string,
    recordedEnvironment: () => Promise<string | null>,
    aggregateLegacyKeys: string[] = [],
    priorKeys: string[] = [],
  ): Promise<void> {
    const tokens = await this.devices.listForUser(userId);
    if (tokens.length === 0) return;
    if (aggregateLegacyKeys.length > 0) {
      const tombstone = await this.prisma.pushDelivery.findFirst({
        where: {
          userId,
          environment: 'legacy',
          key: { in: Array.from(new Set(aggregateLegacyKeys)) },
        },
      });
      if (tombstone) return;
    }
    let environment = await recordedEnvironment();
    if (environment === null) {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      environment = user?.tradingMode === 'practice' ? 'practice' : 'live';
    }
    const fullTitle = environment === 'practice' ? `PRACTICE · ${title}` : title;
    for (const device of tokens) {
      try {
        await this.prisma.$transaction(
          async (database) => {
            // Close the listForUser -> insert ownership race with the same lock
            // used by register and delivery. Whichever operation commits first
            // either creates a valid row or invalidates/skips the stale token.
            await database.$executeRaw(
              Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${device.token}, 0))`,
            );
            const current = await database.deviceToken.findMany({
              where: { userId, token: device.token },
            });
            if (current.length === 0) return;
            const equivalentKeys = Array.from(new Set([key, ...priorKeys]));
            const existing = await database.pushDelivery.findFirst({
              where: {
                userId,
                deviceToken: device.token,
                key: { in: equivalentKeys },
              },
            });
            if (existing) return;
            await database.pushDelivery.create({
              data: {
                userId,
                key,
                deviceToken: device.token,
                environment,
                title: fullTitle,
                body,
              },
            });
          },
          { timeout: TOKEN_TRANSACTION_TIMEOUT_MS },
        );
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
  }

  /** Claims and processes all currently due rows. Public for deterministic
   * two-instance and crash-recovery tests. */
  async processDue(nowOverride?: Date): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const retentionNow = nowOverride ?? new Date();
      try {
        await this.runRetention(retentionNow);
      } catch (error) {
        // Maintenance must not strand user-visible delivery work. The failed
        // lease was released by runRetention, so a later tick will retry it.
        this.logger.error(`push-delivery retention failed: ${(error as Error).message}`);
      }
      // Retention is database maintenance and must run even in deployments
      // where APNs delivery is intentionally disabled.
      if (!this.apns.enabled) return;
      for (;;) {
        const scanNow = nowOverride ?? new Date();
        const candidate = await this.prisma.pushDelivery.findFirst({
          where: this.dueWhere(scanNow),
          orderBy: { createdAt: 'asc' },
        });
        if (!candidate) break;
        const attempts = candidate.attempts + 1;
        const claimNow = nowOverride ?? new Date();
        const leaseExpiresAt = new Date(claimNow.getTime() + LEASE_MS);
        const claimed = await this.prisma.pushDelivery.updateMany({
          where: { id: candidate.id, ...this.dueWhere(claimNow) },
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
          candidate.userId,
          candidate.deviceToken,
          candidate.title,
          candidate.body,
          attempts,
          nowOverride,
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
    userId: string,
    token: string,
    title: string,
    body: string,
    attempts: number,
    nowOverride?: Date,
  ): Promise<void> {
    const owned = { id, status: 'leased', leaseOwnerId: this.ownerId };
    let warning: string | null = null;
    await this.prisma.$transaction(
      async (database) => {
        // The same per-token transaction lock is taken by DevicesService.register.
        // Hold it through the APNs request (bounded by the client's timeout), so
        // ownership cannot change between authorization and disclosure.
        await database.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${token}, 0))`,
        );
        const renewedAt = nowOverride ?? new Date();
        const stillOwned = await database.pushDelivery.updateMany({
          where: owned,
          data: { leaseExpiresAt: new Date(renewedAt.getTime() + LEASE_MS) },
        });
        if (stillOwned.count !== 1) return;
        const current = await database.deviceToken.findMany({ where: { userId, token } });
        if (current.length === 0) {
          await database.pushDelivery.updateMany({
            where: owned,
            data: {
              status: 'dead',
              leaseOwnerId: null,
              leaseExpiresAt: null,
              lastError: 'device token no longer belongs to user',
            },
          });
          return;
        }

        const result = await this.apns.send(token, { title, body });
        const completedAt = nowOverride ?? new Date();
        if (result.status === 200) {
          await database.pushDelivery.updateMany({
            where: owned,
            data: {
              status: 'delivered',
              deliveredAt: completedAt,
              leaseOwnerId: null,
              leaseExpiresAt: null,
              lastError: null,
            },
          });
          return;
        }
        const reason = `${result.status}${result.reason ? ` ${result.reason}` : ''}`;
        if (isDeadToken(result)) {
          await database.pushDelivery.updateMany({
            where: owned,
            data: {
              status: 'dead',
              leaseOwnerId: null,
              leaseExpiresAt: null,
              lastError: reason,
            },
          });
          try {
            await database.deviceToken.deleteMany({ where: { token } });
          } catch (error) {
            this.logger.warn(`dead-token prune failed: ${(error as Error).message}`);
          }
          return;
        }
        const terminal = attempts >= MAX_ATTEMPTS;
        await database.pushDelivery.updateMany({
          where: owned,
          data: {
            status: terminal ? 'dead' : 'retry',
            nextAttemptAt: new Date(completedAt.getTime() + this.backoffMs(attempts)),
            leaseOwnerId: null,
            leaseExpiresAt: null,
            lastError: reason,
          },
        });
        warning = `APNs delivery ${id} failed (${reason}); ${terminal ? 'dead' : 'retrying'}`;
      },
      { timeout: TOKEN_TRANSACTION_TIMEOUT_MS },
    );
    if (warning) this.logger.warn(warning);
  }

  private backoffMs(attempts: number): number {
    return Math.min(60 * 60_000, 1_000 * 2 ** Math.max(0, attempts - 1));
  }

  private async runRetention(now: Date): Promise<void> {
    const day = now.toISOString().slice(0, 10);
    if (this.lastRetentionDay === day || now.getTime() < this.retentionRetryAfter) return;
    const leaseName = 'push-delivery-retention';
    const nextUtcDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const workLeaseExpiresAt = new Date(now.getTime() + 5 * 60_000);
    const claimed = await this.prisma.scheduledJobLease.updateMany({
      where: { name: leaseName, expiresAt: { lt: now } },
      data: { ownerId: this.ownerId, expiresAt: workLeaseExpiresAt },
    });
    if (claimed.count !== 1) {
      try {
        await this.prisma.scheduledJobLease.create({
          data: { name: leaseName, ownerId: this.ownerId, expiresAt: workLeaseExpiresAt },
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          // Another instance owns today's job. Honor its persisted lease
          // instead of rediscovering the same unique row every 500 ms tick.
          const lease = await this.prisma.scheduledJobLease.findUnique({
            where: { name: leaseName },
          });
          const endOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
          this.retentionRetryAfter = lease?.expiresAt.getTime() ?? endOfDay;
          return;
        }
        throw error;
      }
    }
    try {
      await this.prisma.pushDelivery.deleteMany({
        where: {
          status: { in: ['delivered', 'dead'] },
          // Keep the issue's indexed enqueue-age bound, and also require the
          // terminal transition itself to be old. A long-retrying row must get
          // a full dedupe window after it finally becomes delivered/dead.
          createdAt: { lt: new Date(now.getTime() - RETENTION_MS) },
          updatedAt: { lt: new Date(now.getTime() - RETENTION_MS) },
        },
      });
      await this.prisma.scheduledJobLease.updateMany({
        where: { name: leaseName, ownerId: this.ownerId },
        // One stable lease row encodes completion through the next UTC day;
        // date-suffixed names would leak one permanent row per day forever.
        data: { expiresAt: new Date(nextUtcDay) },
      });
      this.lastRetentionDay = day;
      this.retentionRetryAfter = 0;
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

  private async canonicalOrder(
    userId: string,
    aliases: string[],
    environment: TradingMode | undefined,
    identity: Pick<OrderUpdateEvent, 'provider' | 'accountId' | 'brokerOrderId' | 'clientOrderId'>,
  ) {
    if (aliases.length === 0) return null;
    // External ids are provider/environment/account scoped. An older emitter
    // that omitted any part does not authorize choosing whichever matching row
    // findFirst happens to see.
    if (!identity.provider || !environment || !identity.accountId) return null;
    const uuidAliases = aliases.filter((alias) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(alias),
    );
    const alternatives: Record<string, unknown>[] = [
      { brokerOrderId: { in: aliases } },
      { clientOrderId: { in: aliases } },
    ];
    if (uuidAliases.length > 0) alternatives.push({ id: { in: uuidAliases } });
    const rows = await this.prisma.tradeOrder.findMany({
      where: {
        userId,
        provider: identity.provider,
        environment,
        accountId: identity.accountId,
        OR: alternatives,
      },
      take: 2,
    });
    // A split identity should normally have been merged by the priority-100
    // OrdersService ingestor. If an older/direct caller still exposes two
    // rows, refuse an arbitrary findFirst UUID and use the fully scoped
    // fallback key until persistence converges.
    return rows.length === 1 ? rows[0] : null;
  }

  private kickWorker(): void {
    void this.processDue().catch((error: unknown) =>
      this.logger.error(`push-delivery drain failed: ${(error as Error).message}`),
    );
  }
}
