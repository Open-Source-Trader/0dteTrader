import { Inject, Injectable } from '@nestjs/common';
import type { ChartOrder as ChartOrderRow } from '@prisma/client';
import {
  ChartOrder,
  ChartOrderKind,
  ChartOrderStatus,
  OptionType,
  OrderResult,
  OrderSide,
  OrderType,
} from '@0dtetrader/shared-types';
import { BROKER_GATEWAY, BrokerGateway } from '../broker/broker-gateway.interface';
import { findExplicitOption, pickExpiration } from '../broker/contract-resolution';
import { optionSettlementAt } from '../broker/expiration-calendar';
import { ApiException, errors } from '../common/api-exception';
import { BrokerError } from '../common/broker-error';
import { PrismaService } from '../prisma/prisma.service';
import { OrderRequestDto } from '../trading/dto/order-request.dto';
import { TradingService } from '../trading/trading.service';
import { ChartOrderEventsService } from './chart-order-events.service';
import { CreateChartOrderDto, UpdateChartOrderDto } from './dto/chart-order.dto';

/**
 * Deterministic per-line idempotency key. This is what makes the client and the
 * watcher safe to race: the second submission replays the first's result (or is
 * refused as in-flight) instead of placing a second order.
 */
export function idempotencyKeyFor(chartOrderId: string): string {
  return `chartorder:${chartOrderId}`;
}

/**
 * Working lines allowed per user. Each one costs the watcher a broker quote per
 * second while the session is open, so this is a real resource bound, not a
 * style choice.
 */
export const MAX_WORKING_CHART_ORDERS = 20;

/** Terminal lines stay listed this long so the client can show why one failed. */
const TERMINAL_RETENTION_MS = 60 * 60_000;

/**
 * A bracket leg must survive this long before the orphan sweep can retire it.
 * Placing a target and stop the instant a position opens is the normal flow,
 * and the broker does not report the fill immediately — without the grace the
 * sweep would cancel the bracket a beat before the position appears.
 */
const ORPHAN_GRACE_MS = 60_000;

export function toChartOrder(row: ChartOrderRow): ChartOrder {
  return {
    id: row.id,
    underlying: row.underlying,
    triggerPrice: row.triggerPrice,
    armPrice: row.armPrice,
    side: row.side as OrderSide,
    quantity: row.quantity,
    orderType: row.orderType as OrderType,
    kind: row.kind as ChartOrderKind,
    optionType: row.optionType as OptionType,
    expiration: row.expiration,
    strike: row.strike,
    contractSymbol: row.contractSymbol,
    ocoGroupId: row.ocoGroupId,
    status: row.status as ChartOrderStatus,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    triggeredAt: row.triggeredAt?.toISOString() ?? null,
    brokerOrderId: row.brokerOrderId,
    lastError: row.lastError,
  };
}

/**
 * CRUD for chart order lines, plus the state transitions the watcher drives.
 *
 * A line is only ever *armed* here — firing goes through TradingService like
 * any other order, so the kill switch, idempotency, and audit trail all apply
 * unchanged.
 */
@Injectable()
export class ChartOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(BROKER_GATEWAY) private readonly gateway: BrokerGateway,
    private readonly trading: TradingService,
    private readonly events: ChartOrderEventsService,
  ) {}

  // -------------------------------------------------------------------------
  // Client-facing
  // -------------------------------------------------------------------------

  /**
   * Working lines for the user's current environment, plus recently terminal
   * ones so a failed fire stays visible on the chart instead of vanishing.
   */
  async list(userId: string): Promise<ChartOrder[]> {
    const environment = await this.environmentFor(userId);
    const rows = await this.prisma.chartOrder.findMany({
      where: {
        userId,
        environment,
        OR: [
          { status: 'working' },
          { updatedAt: { gt: new Date(Date.now() - TERMINAL_RETENTION_MS) } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toChartOrder);
  }

  async create(userId: string, dto: CreateChartOrderDto): Promise<ChartOrder> {
    const { environment, tradingDisabled } = await this.userContext(userId);
    if (tradingDisabled) {
      throw errors.forbidden(
        'TRADING_DISABLED',
        'Trading is disabled for this account (kill switch)',
      );
    }

    const working = await this.prisma.chartOrder.count({
      where: { userId, environment, status: 'working' },
    });
    if (working >= MAX_WORKING_CHART_ORDERS) {
      throw errors.validation(
        `At most ${MAX_WORKING_CHART_ORDERS} working chart orders — cancel one first`,
      );
    }

    const contract = await this.resolveContract(userId, dto);
    const expiresAt = this.settlementFor(dto.expiration, dto.underlying);
    if (expiresAt.getTime() <= Date.now()) {
      throw errors.validation(`${dto.expiration} has already settled`);
    }

    const armPrice = await this.armPriceFor(userId, dto.underlying, dto.triggerPrice);
    if (dto.ocoGroupId) await this.assertGroupOwned(userId, dto.ocoGroupId);

    const row = await this.prisma.chartOrder.create({
      data: {
        userId,
        environment,
        underlying: dto.underlying.toUpperCase(),
        triggerPrice: dto.triggerPrice,
        armPrice,
        side: dto.side,
        quantity: dto.quantity,
        orderType: dto.orderType,
        kind: dto.kind,
        optionType: dto.optionType,
        expiration: contract.expiration,
        strike: contract.strike,
        contractSymbol: contract.symbol,
        ocoGroupId: dto.ocoGroupId ?? null,
        status: 'working',
        expiresAt,
      },
    });
    return toChartOrder(row);
  }

  /**
   * Moves, resizes, or flips the execution type of a working line. Moving it
   * re-arms from the live quote: the old arm price refers to a level that is no
   * longer there, and keeping it would let the line fire on a crossing that
   * already happened.
   */
  async update(userId: string, id: string, dto: UpdateChartOrderDto): Promise<ChartOrder> {
    const existing = await this.findOwned(userId, id);
    if (existing.status !== 'working') {
      throw errors.conflict(
        'CHART_ORDER_NOT_WORKING',
        `This order is ${existing.status} and can no longer be changed`,
      );
    }

    const data: {
      triggerPrice?: number;
      armPrice?: number;
      quantity?: number;
      orderType?: string;
    } = {};
    if (dto.triggerPrice !== undefined && dto.triggerPrice !== existing.triggerPrice) {
      data.triggerPrice = dto.triggerPrice;
      data.armPrice = await this.armPriceFor(userId, existing.underlying, dto.triggerPrice);
    }
    if (dto.quantity !== undefined) data.quantity = dto.quantity;
    if (dto.orderType !== undefined) data.orderType = dto.orderType;

    // Re-check the status in the write itself: the watcher may have claimed the
    // line between the read above and here.
    const updated = await this.prisma.chartOrder.updateMany({
      where: { id, userId, status: 'working' },
      data,
    });
    if (updated.count === 0) {
      throw errors.conflict(
        'CHART_ORDER_NOT_WORKING',
        'This order just fired and can no longer be changed',
      );
    }
    return toChartOrder(await this.findOwned(userId, id));
  }

  /** Cancels a working line. Nothing was ever sent to the broker. */
  async cancel(userId: string, id: string): Promise<void> {
    await this.findOwned(userId, id);
    const cancelled = await this.prisma.chartOrder.updateMany({
      where: { id, userId, status: 'working' },
      data: { status: 'cancelled' },
    });
    if (cancelled.count === 0) {
      throw errors.conflict(
        'CHART_ORDER_NOT_WORKING',
        'This order already fired and cannot be cancelled here',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Watcher-facing state transitions
  // -------------------------------------------------------------------------

  /**
   * Every line eligible to fire right now, across all users.
   *
   * Filtered to lines whose environment matches their owner's CURRENT trading
   * mode. This is the one place that check can be made: firing goes through
   * TradingService, which routes to whichever environment the user is in
   * *now* — so without this, a line armed in practice would send a real order
   * the moment the user switched to live.
   */
  async armedOrders(now: Date): Promise<ChartOrderRow[]> {
    const rows = await this.prisma.chartOrder.findMany({
      where: { status: 'working', expiresAt: { gt: now } },
      orderBy: { createdAt: 'asc' },
    });
    if (rows.length === 0) return [];

    // One batched lookup: this runs every watcher tick, so a per-user
    // findUnique loop would be (1 + users) sequential queries per second.
    const userIds = [...new Set(rows.map((row) => row.userId))];
    const users = await this.prisma.user.findMany({ where: { id: { in: userIds } } });
    // An account that has since been deleted arms nothing.
    const environments = new Map(
      users.map((user) => [user.id, user.tradingMode === 'practice' ? 'practice' : 'live']),
    );
    return rows.filter((row) => row.environment === environments.get(row.userId));
  }

  /**
   * Atomically claims a line for firing. Returns false when someone else got
   * there first, which is what keeps a slow tick from double-submitting.
   */
  async claimForFire(id: string, now: Date): Promise<boolean> {
    const claimed = await this.prisma.chartOrder.updateMany({
      where: { id, status: 'working' },
      data: { status: 'triggered', triggeredAt: now, lastError: null },
    });
    return claimed.count === 1;
  }

  /**
   * Client-initiated fire: the app saw the crossing on its own quote stream and
   * does not want to wait for the watcher's next poll. Same claim and same
   * idempotency key as the watcher, so the two racing produces one broker order.
   */
  async triggerNow(userId: string, id: string, now = new Date()): Promise<ChartOrder> {
    const row = await this.findOwned(userId, id);
    return this.fire(row, now);
  }

  /**
   * Claims and sends a line. Returns the resulting state whichever way it went:
   * `triggered` on success (or when a concurrent caller got there first),
   * `failed` with the reason when the broker refused it.
   *
   * A failed fire is left visible and re-armable rather than silently dropped —
   * "your stop tried to fire and was rejected, here is why" is the only honest
   * outcome, and retrying blindly could put an order in at a far worse level.
   */
  async fire(row: ChartOrderRow, now: Date): Promise<ChartOrder> {
    if (!(await this.claimForFire(row.id, now))) {
      // Lost the claim: whatever the winner did is the truth.
      return toChartOrder((await this.byId(row.id)) ?? row);
    }

    // Environment gate at the money boundary. TradingService routes to the
    // user's CURRENT trading mode, so a line armed in the other environment
    // must never reach the broker — no matter which caller saw the crossing
    // (the watcher pre-filters via armedOrders, but a client trigger arrives
    // here directly, and the user can flip modes between any check and this
    // point). Checked AFTER the claim so there is no check-then-act window:
    // a mismatch un-claims the line, leaving it armed for the mode it belongs
    // to, exactly as the watcher treats it.
    const { environment } = await this.userContext(row.userId);
    if (row.environment !== environment) {
      return toChartOrder(
        await this.prisma.chartOrder.update({
          where: { id: row.id },
          data: { status: 'working', triggeredAt: null },
        }),
      );
    }

    // A settled contract cannot be traded; retire the line instead of letting
    // a client fire it in the window before the watcher's expiry sweep.
    if (row.expiresAt.getTime() <= now.getTime()) {
      const expired = toChartOrder(
        await this.prisma.chartOrder.update({
          where: { id: row.id },
          data: { status: 'expired' },
        }),
      );
      this.events.emit(row.userId, expired);
      return expired;
    }

    const request: OrderRequestDto = {
      underlying: row.underlying,
      assetClass: 'option',
      side: row.side as OrderSide,
      quantity: row.quantity,
      orderType: row.orderType as OrderType,
      selection: {
        mode: 'explicit',
        optionType: row.optionType as OptionType,
        expiration: row.expiration,
        strike: row.strike,
      },
    };

    let placed: OrderResult;
    try {
      placed = await this.trading.place(row.userId, request, idempotencyKeyFor(row.id));
    } catch (err) {
      // The other caller's submission for this same line is still in flight.
      // The claim is already correct — let their result stand.
      if (err instanceof ApiException && err.code === 'ORDER_IN_FLIGHT') {
        return toChartOrder((await this.byId(row.id)) ?? row);
      }
      const message = err instanceof Error ? err.message : String(err);
      const failed = toChartOrder(
        await this.prisma.chartOrder.update({
          where: { id: row.id },
          data: { status: 'failed', lastError: message.slice(0, 500) },
        }),
      );
      this.events.emit(row.userId, failed);
      return failed;
    }

    // The broker accepted the order. From here every failure is bookkeeping
    // and must NEVER relabel the line as failed: a "failed" line dismisses
    // locally with no server call, so the user would lose chart-side tracking
    // of a live order — and its OCO sibling would stay armed to close the
    // position a second time.
    let updated: ChartOrder;
    try {
      updated = toChartOrder(
        await this.prisma.chartOrder.update({
          where: { id: row.id },
          data: { brokerOrderId: placed.orderId },
        }),
      );
    } catch {
      // The row is already `triggered` from the claim; only the broker id is
      // missing. Report the true state from what we know in memory.
      updated = {
        ...toChartOrder(row),
        status: 'triggered',
        triggeredAt: now.toISOString(),
        brokerOrderId: placed.orderId,
      };
    }
    try {
      await this.retireSiblings(row);
    } catch {
      // The orphan sweep retires the sibling on the next reconcile pass once
      // the position it brackets is gone — do not fail the fired leg over it.
    }
    this.events.emit(row.userId, updated);
    return updated;
  }

  /** OCO: the leg that fired retires the other one. */
  private async retireSiblings(row: ChartOrderRow): Promise<void> {
    if (!row.ocoGroupId) return;
    for (const id of await this.cancelSiblings(row.ocoGroupId, row.id)) {
      const sibling = await this.byId(id);
      if (sibling) this.events.emit(row.userId, toChartOrder(sibling));
    }
  }

  /** OCO: one leg firing retires the other. */
  async cancelSiblings(ocoGroupId: string, exceptId: string): Promise<string[]> {
    const siblings = await this.prisma.chartOrder.findMany({
      where: { ocoGroupId, status: 'working', NOT: { id: exceptId } },
    });
    if (siblings.length === 0) return [];
    await this.prisma.chartOrder.updateMany({
      where: { ocoGroupId, status: 'working', NOT: { id: exceptId } },
      data: { status: 'cancelled' },
    });
    return siblings.map((row) => row.id);
  }

  /** Retires working lines whose contract has settled. */
  async expireSettled(now: Date): Promise<number> {
    const { count } = await this.prisma.chartOrder.updateMany({
      where: { status: 'working', expiresAt: { lte: now } },
      data: { status: 'expired' },
    });
    return count;
  }

  /**
   * Retires bracket legs whose position is gone (closed by hand, by the other
   * leg, or at the broker). Without this a stale stop would fire into nothing.
   *
   * Legs younger than the grace period are left alone: a bracket placed in the
   * same moment its position is opening would otherwise be cancelled before the
   * broker reports the fill.
   */
  async cancelOrphanedBrackets(
    userId: string,
    environment: string,
    openContractSymbols: string[],
    now: Date = new Date(),
  ): Promise<string[]> {
    const orphans = await this.prisma.chartOrder.findMany({
      where: {
        userId,
        environment,
        status: 'working',
        kind: { in: ['target', 'stop'] },
        createdAt: { lt: new Date(now.getTime() - ORPHAN_GRACE_MS) },
        NOT: { contractSymbol: { in: openContractSymbols } },
      },
    });
    if (orphans.length === 0) return [];
    await this.prisma.chartOrder.updateMany({
      where: { id: { in: orphans.map((row) => row.id) } },
      data: { status: 'cancelled' },
    });
    return orphans.map((row) => row.id);
  }

  byId(id: string): Promise<ChartOrderRow | null> {
    return this.prisma.chartOrder.findUnique({ where: { id } });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async userContext(
    userId: string,
  ): Promise<{ environment: string; tradingDisabled: boolean }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw errors.unauthorized('USER_NOT_FOUND', 'User no longer exists');
    return {
      environment: user.tradingMode === 'practice' ? 'practice' : 'live',
      tradingDisabled: user.tradingDisabled,
    };
  }

  private async environmentFor(userId: string): Promise<string> {
    return (await this.userContext(userId)).environment;
  }

  private async findOwned(userId: string, id: string): Promise<ChartOrderRow> {
    const row = await this.prisma.chartOrder.findUnique({ where: { id } });
    if (!row || row.userId !== userId) {
      throw errors.notFound('CHART_ORDER_NOT_FOUND', 'No such chart order');
    }
    return row;
  }

  private async assertGroupOwned(userId: string, ocoGroupId: string): Promise<void> {
    const existing = await this.prisma.chartOrder.findFirst({ where: { ocoGroupId } });
    if (existing && existing.userId !== userId) {
      throw errors.notFound('CHART_ORDER_NOT_FOUND', 'No such bracket group');
    }
  }

  /**
   * The underlying's price right now, rejected when it sits exactly on the
   * trigger — the line would have no side to be crossed from, so it would fire
   * on the very next tick in either direction.
   */
  private async armPriceFor(
    userId: string,
    underlying: string,
    triggerPrice: number,
  ): Promise<number> {
    const quote = await this.gateway.getQuote(userId, underlying);
    const last = quote.last;
    if (!Number.isFinite(last) || last <= 0) {
      throw errors.unavailable(
        'QUOTE_UNAVAILABLE',
        `No usable ${underlying} quote to arm this order against`,
      );
    }
    if (last === triggerPrice) {
      throw errors.validation(
        `Trigger sits exactly on the current ${underlying} price — move the line off ${triggerPrice}`,
      );
    }
    return last;
  }

  /** Re-resolves the contract from live chain data; the client's strike is advisory. */
  private async resolveContract(
    userId: string,
    dto: CreateChartOrderDto,
  ): Promise<{ symbol: string; strike: number; expiration: string }> {
    let chain;
    try {
      chain = await this.gateway.getOptionsChain(userId, dto.underlying, dto.expiration);
    } catch (err) {
      if (err instanceof BrokerError && err.code === 'CONTRACT_NOT_FOUND') {
        throw errors.validation(err.message);
      }
      throw err;
    }
    const expiration = pickExpiration(chain.expirations, dto.expiration);
    const contract = findExplicitOption(chain.contracts, dto.optionType, dto.strike);
    if (!contract) {
      throw errors.validation(
        `No ${dto.optionType} contract at strike ${dto.strike} ` +
          `for ${dto.underlying} expiring ${expiration}`,
      );
    }
    return { symbol: contract.symbol, strike: contract.strike, expiration };
  }

  private settlementFor(expiration: string, underlying: string): Date {
    try {
      return optionSettlementAt(expiration, underlying);
    } catch (err) {
      throw errors.validation((err as Error).message);
    }
  }
}
