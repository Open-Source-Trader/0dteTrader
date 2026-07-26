import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChartOrder as ChartOrderRow } from '@prisma/client';
import { chartOrderCrossed } from '@0dtetrader/shared-types';
import { BROKER_GATEWAY, BrokerGateway } from '../broker/broker-gateway.interface';
import { isRegularMarketSessionOpen } from '../broker/expiration-calendar';
import { PrismaService } from '../prisma/prisma.service';
import { ChartOrderEventsService } from './chart-order-events.service';
import { ChartOrdersService, toChartOrder } from './chart-orders.service';

const LEASE_NAME = 'chart-order-watcher';
/** Lease outlives several ticks so a slow broker call cannot drop it mid-flight. */
const LEASE_MS = 30_000;
const LEASE_RENEW_MS = 10_000;
/** Expiry sweep and bracket-orphan reconciliation cadence. */
const RECONCILE_MS = 30_000;

interface Observation {
  price: number;
  /** Epoch ms this price was observed, used to decide whether a line's own arm
   *  price is the more recent starting point for the crossing test. */
  at: number;
}

export interface ChartOrderWatcherMetrics {
  ticks: number;
  fired: number;
  failed: number;
  expired: number;
  orphansCancelled: number;
  quoteFailures: number;
}

/**
 * Fires chart order lines with no client connected.
 *
 * Leased singleton (one watcher per deployment) modelled on
 * OptionsAnalyticsCaptureService. The crossing test always runs from the last
 * price this watcher actually *observed* — falling back to the line's own
 * `armPrice` when the line is newer than that observation — so a slow tick, a
 * restart, or a failover cannot step over a level unnoticed. Firing goes
 * through TradingService with a deterministic idempotency key, so a client that
 * fires the same line at the same moment produces one broker order, not two.
 */
@Injectable()
export class ChartOrderWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChartOrderWatcherService.name);
  private readonly leaseOwnerId = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private tickRunning = false;
  private leaseRenewedAt = 0;
  private ownsLease = false;
  private lastReconcileAt = 0;
  /** Last observed underlying price, keyed `${userId}|${underlying}`. */
  private readonly observations = new Map<string, Observation>();

  readonly metrics: ChartOrderWatcherMetrics = {
    ticks: 0,
    fired: 0,
    failed: 0,
    expired: 0,
    orphansCancelled: 0,
    quoteFailures: 0,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly chartOrders: ChartOrdersService,
    private readonly events: ChartOrderEventsService,
    @Inject(BROKER_GATEWAY) private readonly gateway: BrokerGateway,
    private readonly config: ConfigService,
  ) {}

  get schedulerActive(): boolean {
    return this.timer !== null;
  }

  onModuleInit(): void {
    if (this.config.get<boolean>('chartOrders.watcherEnabled') !== true) {
      this.logger.log(JSON.stringify({ event: 'chart_order_watcher_disabled' }));
      return;
    }
    const tickMs = this.config.get<number>('chartOrders.tickMs') ?? 1_000;
    this.timer = setInterval(() => void this.tick(new Date()), tickMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One watcher pass. Exposed (rather than private) so tests can drive it with
   * an injected clock instead of waiting on the interval.
   */
  async tick(now: Date): Promise<void> {
    if (this.tickRunning) return;
    this.tickRunning = true;
    try {
      if (!(await this.holdLease(now))) return;
      this.metrics.ticks += 1;

      if (now.getTime() - this.lastReconcileAt >= RECONCILE_MS) {
        this.lastReconcileAt = now.getTime();
        await this.reconcile(now);
      }

      // Outside the cash session nothing can cross, and the broker's quotes go
      // stale — the expiry sweep above still runs so lines retire on schedule.
      if (!isRegularMarketSessionOpen(now)) return;

      const rows = await this.chartOrders.armedOrders(now);
      if (rows.length === 0) return;

      const groups = new Map<string, ChartOrderRow[]>();
      for (const row of rows) {
        const key = `${row.userId}|${row.underlying}`;
        const group = groups.get(key);
        if (group) group.push(row);
        else groups.set(key, [row]);
      }

      await Promise.all([...groups].map(([key, group]) => this.checkGroup(key, group, now)));
    } catch (err) {
      this.logger.error(
        JSON.stringify({
          event: 'chart_order_watcher_tick_failed',
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      this.tickRunning = false;
    }
  }

  // -------------------------------------------------------------------------
  // Crossing detection
  // -------------------------------------------------------------------------

  private async checkGroup(key: string, group: ChartOrderRow[], now: Date): Promise<void> {
    const [userId, underlying] = key.split('|');
    let last: number;
    let quotedAt: number;
    try {
      const quote = await this.gateway.getQuote(userId, underlying);
      last = quote.last;
      const parsed = Date.parse(quote.timestamp);
      quotedAt = Number.isFinite(parsed) ? parsed : now.getTime();
    } catch (err) {
      this.metrics.quoteFailures += 1;
      this.logger.warn(
        JSON.stringify({
          event: 'chart_order_quote_failed',
          underlying,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      return;
    }

    if (!Number.isFinite(last) || last <= 0) return;

    // A stale quote is the one input that must never fire an order: a halted or
    // dead feed would otherwise replay an old price against every level.
    const staleMs = this.config.get<number>('chartOrders.staleQuoteMs') ?? 10_000;
    if (now.getTime() - quotedAt > staleMs) {
      this.observations.delete(key); // resume from each line's arm price
      return;
    }

    const previous = this.observations.get(key);
    this.observations.set(key, { price: last, at: now.getTime() });

    for (const row of group) {
      // Start from whichever reference is more recent: the last price this
      // watcher saw, or the price the line was armed at.
      const armedAfterObservation = !previous || row.updatedAt.getTime() >= previous.at;
      const from = armedAfterObservation ? row.armPrice : previous.price;
      if (!chartOrderCrossed(row, from, last)) continue;
      await this.fire(row, now, last);
    }
  }

  // -------------------------------------------------------------------------
  // Firing
  // -------------------------------------------------------------------------

  private async fire(row: ChartOrderRow, now: Date, crossedAt: number): Promise<void> {
    // The claim, the broker call, the OCO retirement, and the event all live in
    // ChartOrdersService, so a client-initiated trigger takes the identical path.
    const updated = await this.chartOrders.fire(row, now);

    if (updated.status === 'failed') {
      this.metrics.failed += 1;
      this.logger.warn(
        JSON.stringify({
          event: 'chart_order_fire_failed',
          chartOrderId: row.id,
          underlying: row.underlying,
          message: updated.lastError,
        }),
      );
      return;
    }
    if (updated.brokerOrderId) {
      this.metrics.fired += 1;
      this.logger.log(
        JSON.stringify({
          event: 'chart_order_fired',
          chartOrderId: row.id,
          underlying: row.underlying,
          triggerPrice: row.triggerPrice,
          crossedAt,
          orderId: updated.brokerOrderId,
        }),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------

  /**
   * Retires lines that can no longer do anything: settled contracts, and
   * bracket legs whose position is gone (closed by hand, by the other leg, or
   * at the broker). A stop with nothing behind it would otherwise fire into an
   * empty position.
   */
  private async reconcile(now: Date): Promise<void> {
    const expired = await this.chartOrders.expireSettled(now);
    if (expired > 0) this.metrics.expired += expired;

    // armedOrders already narrows to each owner's current environment, so the
    // positions read below is compared against brackets from the same account
    // mode — never practice legs against live positions.
    const rows = await this.chartOrders.armedOrders(now);
    const bracketed = rows.filter((row) => row.kind === 'target' || row.kind === 'stop');
    const byUser = new Map<string, string>();
    for (const row of bracketed) byUser.set(row.userId, row.environment);

    for (const [userId, environment] of byUser) {
      try {
        const positions = await this.gateway.getPositions(userId);
        const open = positions.filter((p) => p.quantity !== 0).map((p) => p.symbol);
        const orphans = await this.chartOrders.cancelOrphanedBrackets(
          userId,
          environment,
          open,
          now,
        );
        for (const id of orphans) {
          this.metrics.orphansCancelled += 1;
          const row = await this.chartOrders.byId(id);
          if (row) this.events.emit(userId, toChartOrder(row));
        }
      } catch (err) {
        // A positions read that fails must not retire live brackets.
        this.logger.warn(
          JSON.stringify({
            event: 'chart_order_reconcile_failed',
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Lease
  // -------------------------------------------------------------------------

  /**
   * Holds a single-watcher lease so a multi-instance deployment fires each line
   * once. Renewed well inside its own expiry; a lost lease simply stops this
   * instance from processing until it wins the lease back.
   */
  private async holdLease(now: Date): Promise<boolean> {
    if (this.ownsLease && now.getTime() - this.leaseRenewedAt < LEASE_RENEW_MS) return true;
    const expiresAt = new Date(now.getTime() + LEASE_MS);
    try {
      const taken = await this.prisma.scheduledJobLease.updateMany({
        where: {
          name: LEASE_NAME,
          OR: [{ expiresAt: { lt: now } }, { ownerId: this.leaseOwnerId }],
        },
        data: { ownerId: this.leaseOwnerId, expiresAt },
      });
      if (taken.count === 0) {
        try {
          await this.prisma.scheduledJobLease.create({
            data: { name: LEASE_NAME, ownerId: this.leaseOwnerId, expiresAt },
          });
        } catch {
          // Another instance holds a live lease.
          this.ownsLease = false;
          return false;
        }
      }
      this.ownsLease = true;
      this.leaseRenewedAt = now.getTime();
      // A lease handover means the new owner has no price history; every line
      // then resumes from its own arm price, which is exactly what we want.
      return true;
    } catch (err) {
      this.ownsLease = false;
      this.logger.error(
        JSON.stringify({
          event: 'chart_order_watcher_lease_failed',
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      return false;
    }
  }
}
