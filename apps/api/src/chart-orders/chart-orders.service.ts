import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChartOrder as ChartOrderRow, Prisma } from '@prisma/client';
import {
  ChartOrder,
  ChartOrderKind,
  ChartOrderStatus,
  ChartOrderType,
  OptionType,
  OrderResult,
  OrderSide,
  TradingMode,
  chartOrderCrossed,
} from '@0dtetrader/shared-types';
import { BROKER_GATEWAY, BrokerGateway } from '../broker/broker-gateway.interface';
import { findExplicitOption, pickExpiration } from '../broker/contract-resolution';
import { optionSettlementAt } from '../broker/expiration-calendar';
import { ApiException, errors, isUniqueViolation } from '../common/api-exception';
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
const GROUP_FIRE_LEASE_MS = 30_000;
const PENDING_AUDIT_TTL_MS = 2 * 60_000;

class BracketFireClaimLost extends Error {}

export function toChartOrder(row: ChartOrderRow): ChartOrder {
  return {
    id: row.id,
    underlying: row.underlying,
    triggerPrice: row.triggerPrice,
    armPrice: row.armPrice,
    side: row.side as OrderSide,
    quantity: row.quantity,
    orderType: row.orderType as ChartOrderType,
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
  private readonly fireOwnerId = randomUUID();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BROKER_GATEWAY) private readonly gateway: BrokerGateway,
    private readonly trading: TradingService,
    private readonly events: ChartOrderEventsService,
    private readonly config: ConfigService,
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
    let row: ChartOrderRow;
    try {
      const createOrder = (database: Prisma.TransactionClient): Promise<ChartOrderRow> =>
        database.chartOrder.create({
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
      row = dto.ocoGroupId
        ? await this.prisma.$transaction(async (database) => {
            await this.ensureBracketGroup(
              userId,
              environment,
              dto,
              contract.symbol,
              dto.ocoGroupId!,
              database,
            );
            return createOrder(database);
          })
        : await createOrder(this.prisma);
    } catch (error) {
      if (isUniqueViolation(error) && dto.ocoGroupId) {
        throw errors.conflict(
          'OCO_GROUP_DUPLICATE_KIND',
          `That bracket already has a ${dto.kind} — move it instead of adding another`,
        );
      }
      throw error;
    }
    // Close the phantom-insert window: a concurrent fire may have claimed the
    // group after our pre-insert check. Such a late leg is retired immediately
    // and never becomes another close order.
    if (dto.ocoGroupId) {
      const group = await this.prisma.bracketGroup.findUnique({ where: { id: dto.ocoGroupId } });
      if (!group || group.status !== 'working') {
        await this.prisma.chartOrder.updateMany({
          where: { id: row.id, status: 'working' },
          data: { status: 'cancelled' },
        });
        throw errors.conflict('OCO_GROUP_CLOSED', 'That bracket has already fired');
      }
    }
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
    let bracketResized = false;
    if (dto.triggerPrice !== undefined && dto.triggerPrice !== existing.triggerPrice) {
      data.triggerPrice = dto.triggerPrice;
      data.armPrice = await this.armPriceFor(userId, existing.underlying, dto.triggerPrice);
    }
    if (dto.quantity !== undefined) {
      if (existing.ocoGroupId) {
        const resized = await this.prisma.bracketGroup.updateMany({
          where: { id: existing.ocoGroupId, userId, status: 'working' },
          data: { protectedQuantity: dto.quantity },
        });
        if (resized.count === 0) {
          throw errors.conflict('OCO_GROUP_CLOSED', 'That bracket is already firing');
        }
        await this.prisma.chartOrder.updateMany({
          where: { ocoGroupId: existing.ocoGroupId, userId, status: 'working' },
          data: { quantity: dto.quantity },
        });
        bracketResized = true;
      } else {
        data.quantity = dto.quantity;
      }
    }
    if (dto.orderType !== undefined) data.orderType = dto.orderType;

    // A patch that changes nothing must not write. `updatedAt` is load-bearing:
    // the watcher reads it to decide whether a line is newer than its last
    // observed price, and bumping it silently resets that line's crossing test
    // back to `armPrice`. An empty (or no-op) PATCH is a read, so answer it.
    if (Object.keys(data).length === 0) {
      return toChartOrder(bracketResized ? await this.findOwned(userId, id) : existing);
    }

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
    // The client is a latency optimisation, never an authority. It reports only
    // *that* it saw a crossing; the server re-derives whether one happened, from
    // its own quote, under the same staleness gate the watcher applies. Without
    // this an authenticated client could fire any of its own working lines at
    // any price and at any time — a client bug or a wedged in-app quote stream
    // would send a market order nobody asked for.
    // A settled line needs no quote: `fire` retires it, and refusing it for a
    // stale quote would report the wrong reason.
    if (row.status === 'working' && row.expiresAt.getTime() > now.getTime()) {
      const last = await this.freshQuote(userId, row.underlying, now);
      // From `armPrice`, not from a last-observed price: the same gap-safe
      // reference the watcher uses, so a level jumped in one tick still counts.
      if (!chartOrderCrossed(toChartOrder(row), row.armPrice, last)) {
        throw errors.conflict(
          'CHART_ORDER_NOT_CROSSED',
          `${row.underlying} has not crossed ${row.triggerPrice} — this order stays armed`,
        );
      }
    }
    return this.fire(row, now);
  }

  /**
   * The underlying's price now, refused when the feed is stale.
   *
   * A halted or dead feed replays an old price against a live level, which is
   * the one input that must never fire an order. An unreadable timestamp is
   * unverifiable, so it counts as stale rather than as fresh.
   */
  private async freshQuote(userId: string, underlying: string, now: Date): Promise<number> {
    const quote = await this.gateway.getQuote(userId, underlying);
    const last = quote.last;
    if (!Number.isFinite(last) || last <= 0) {
      throw errors.unavailable('QUOTE_UNAVAILABLE', `No usable ${underlying} quote right now`);
    }
    const quotedAt = Date.parse(quote.timestamp);
    const staleMs = this.config.get<number>('chartOrders.staleQuoteMs') ?? 10_000;
    if (!Number.isFinite(quotedAt) || now.getTime() - quotedAt > staleMs) {
      throw errors.unavailable(
        'QUOTE_STALE',
        `The ${underlying} quote is stale — refusing to act on it`,
      );
    }
    return last;
  }

  /**
   * Claims and sends a line. Returns the resulting state whichever way it went:
   * `triggered` on success; `cancelled` when this leg lost an OCO race and the
   * winner retired it; the winner's row when another caller claimed this same
   * line first; `failed` with the reason when the broker refused it.
   *
   * A failed fire is left visible and re-armable rather than silently dropped —
   * "your stop tried to fire and was rejected, here is why" is the only honest
   * outcome, and retrying blindly could put an order in at a far worse level.
   */
  async fire(row: ChartOrderRow, now: Date): Promise<ChartOrder> {
    const claim = await this.claimForFireWithSiblings(row, now);
    if (!claim.won) {
      // Lost the claim: whatever the winner did is the truth.
      if (!row.ocoGroupId) return toChartOrder((await this.byId(row.id)) ?? row);
      // The group claim and sibling retirement are two guarded statements.
      // A simultaneous losing request can observe the tiny interval between
      // them; yielding briefly prevents us from returning a phantom `working`
      // leg while the winning transaction path is already retiring it.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const current = await this.byId(row.id);
        if (!current || current.status !== 'working') return toChartOrder(current ?? row);
        const group = await this.prisma.bracketGroup.findUnique({ where: { id: row.ocoGroupId } });
        if (!group || group.status !== 'pending_fire') return toChartOrder(current);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return toChartOrder((await this.byId(row.id)) ?? row);
    }
    // Tell the clients the moment the siblings are retired, not after the
    // broker round-trip — otherwise a dead leg is drawn as live and draggable
    // for the few hundred milliseconds that matter most.
    await this.emitByIds(row.userId, claim.retired);

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
      const unclaimed = toChartOrder(
        await this.prisma.chartOrder.update({
          where: { id: row.id },
          data: { status: 'working', triggeredAt: null },
        }),
      );
      // Nothing reached the broker, so the bracket must survive intact.
      await this.restoreRetired(row.userId, claim.retired);
      if (row.ocoGroupId) await this.restoreGroupClaim(row.ocoGroupId);
      return unclaimed;
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
      // Again nothing was sent: re-arm the siblings rather than reporting them
      // `cancelled`, which reads as "the other leg filled". Each one retires on
      // its own `expiresAt` via the watcher's expiry sweep.
      await this.restoreRetired(row.userId, claim.retired);
      if (row.ocoGroupId) {
        await this.prisma.bracketGroup.updateMany({
          where: { id: row.ocoGroupId, status: 'pending_fire', fireLegId: row.id },
          data: {
            status: 'expired',
            leaseOwnerId: null,
            leaseExpiresAt: null,
          },
        });
      }
      this.events.emit(row.userId, expired);
      return expired;
    }

    // The caller's row was read before the claim; a size or MID/MKT edit that
    // committed in between is part of the line the user armed, so send what the
    // row says now rather than the snapshot we were handed.
    const fresh = (await this.byId(row.id)) ?? row;
    const request: OrderRequestDto = {
      underlying: fresh.underlying,
      assetClass: 'option',
      side: fresh.side as OrderSide,
      // A resize claims protectedQuantity before touching the individual
      // legs. If a fire lands in that narrow middle window, the group value is
      // authoritative and prevents the stale leg snapshot from over-closing.
      quantity: claim.protectedQuantity ?? fresh.quantity,
      // `ChartOrderType`, not `OrderType`: a line can only ever be MID or MKT,
      // and the fire path is exactly where a widened union must not leak — this
      // request is built with nobody present and no price to type.
      orderType: fresh.orderType as ChartOrderType,
      selection: {
        mode: 'explicit',
        optionType: fresh.optionType as OptionType,
        expiration: fresh.expiration,
        strike: fresh.strike,
      },
    };

    let placed: OrderResult;
    try {
      // The environment this line was armed in, asserted all the way to the
      // send. The gate above proves the account is in that mode *now*; this
      // proves it has not moved by the time the order actually goes out — the
      // chain fetch inside `place` is long enough for a Profile toggle to land
      // in between, and re-deriving the mode at the gateway would silently
      // route a practice line's order to the live account.
      placed = await this.trading.place(
        row.userId,
        request,
        idempotencyKeyFor(row.id),
        row.environment as TradingMode,
        fresh.kind === 'target' || fresh.kind === 'stop',
      );
    } catch (err) {
      // The other caller's submission for this same line is still in flight.
      // The claim is already correct — let their result stand.
      if (err instanceof ApiException && err.code === 'ORDER_IN_FLIGHT') {
        // Their submission stands, so the retirement stands with it.
        return toChartOrder((await this.byId(row.id)) ?? row);
      }
      const message = err instanceof Error ? err.message : String(err);
      const failed = toChartOrder(
        await this.prisma.chartOrder.update({
          where: { id: row.id },
          data: { status: 'failed', lastError: message.slice(0, 500) },
        }),
      );
      // Nothing reached the broker, so the bracket should survive intact —
      // re-arm the siblings this claim retired rather than leaving the position
      // with neither a target nor a stop.
      await this.restoreRetired(row.userId, claim.retired);
      if (row.ocoGroupId) {
        await this.prisma.bracketGroup.updateMany({
          where: { id: row.ocoGroupId, leaseOwnerId: this.fireOwnerId, status: 'pending_fire' },
          data: {
            status: 'working',
            fireLegId: null,
            leaseOwnerId: null,
            leaseExpiresAt: null,
            lastError: message.slice(0, 500),
          },
        });
      }
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
          data: { status: 'triggered', brokerOrderId: placed.orderId },
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
    if (row.ocoGroupId) {
      await this.prisma.bracketGroup
        .updateMany({
          where: { id: row.ocoGroupId, fireLegId: row.id, status: 'pending_fire' },
          data: {
            status: 'fired',
            leaseOwnerId: null,
            leaseExpiresAt: null,
            lastError: null,
          },
        })
        .catch(() => undefined);
    }
    this.events.emit(row.userId, updated);
    return updated;
  }

  /**
   * Claims a line for firing, taking its whole OCO group with it.
   *
   * A bracket must send at most one order. Claiming per-row does not achieve
   * that: on a fast whipsaw the client fires the target and the stop within the
   * same broker round-trip, each wins its own row, and both reach the broker —
   * closing the position and then reversing it. Retiring the sibling after
   * `place()` returns is far too late, and by then it is no longer `working` so
   * the retirement matches nothing.
   *
   * So the claim is one statement over the entire group: the database
   * serialises it, the loser matches zero rows, and the winner retires the
   * siblings *before* anything is sent.
   */
  private async claimForFireWithSiblings(
    row: ChartOrderRow,
    now: Date,
  ): Promise<{ won: boolean; retired: string[]; protectedQuantity?: number }> {
    if (!row.ocoGroupId) {
      return { won: await this.claimForFire(row.id, now), retired: [] };
    }
    try {
      return await this.prisma.$transaction(async (database) => {
        const groupClaim = await database.bracketGroup.updateMany({
          where: {
            id: row.ocoGroupId!,
            userId: row.userId,
            environment: row.environment,
            status: 'working',
          },
          data: {
            status: 'pending_fire',
            fireLegId: row.id,
            leaseOwnerId: this.fireOwnerId,
            leaseExpiresAt: new Date(now.getTime() + GROUP_FIRE_LEASE_MS),
            lastError: null,
          },
        });
        if (groupClaim.count !== 1) return { won: false, retired: [] };
        const claimedGroup = await database.bracketGroup.findUnique({
          where: { id: row.ocoGroupId! },
        });

        // Scope every query in this claim to the owner and environment as well
        // as the group: ids are client-supplied and may never cross tenants.
        const group = {
          ocoGroupId: row.ocoGroupId,
          userId: row.userId,
          environment: row.environment,
        };
        const selfClaim = await database.chartOrder.updateMany({
          where: { id: row.id, ...group, status: 'working' },
          data: { status: 'pending_fire', triggeredAt: now, lastError: null },
        });
        if (selfClaim.count !== 1) throw new BracketFireClaimLost();

        const siblings = await database.chartOrder.findMany({
          where: { ...group, status: 'working', NOT: { id: row.id } },
        });
        if (siblings.length > 0) {
          await database.chartOrder.updateMany({
            where: { ...group, status: 'working', NOT: { id: row.id } },
            data: { status: 'cancelled', triggeredAt: null },
          });
        }
        return {
          won: true,
          retired: siblings.map((sibling) => sibling.id),
          protectedQuantity: claimedGroup?.protectedQuantity,
        };
      });
    } catch (error) {
      if (error instanceof BracketFireClaimLost) return { won: false, retired: [] };
      // The transaction rolled every claim write back. Treat an unavailable
      // retirement write as a lost claim: nothing reached the broker and the
      // still-working line remains eligible for a later healthy tick.
      return { won: false, retired: [] };
    }
  }

  /**
   * Re-arms siblings a claim retired, after the fire turned out to send nothing.
   *
   * The invariant every early return in `fire()` shares: the group claim retires
   * the siblings *before* the broker call, so any path that does not reach the
   * broker — refused, wrong environment, settled contract — owes them back. A
   * leg left `cancelled` without a fill reads to the user (and to the client's
   * OCO logic) as "the other leg filled", and silently unbrackets the position.
   */
  private async restoreRetired(userId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.chartOrder.updateMany({
      where: { id: { in: ids }, status: 'cancelled' },
      data: { status: 'working' },
    });
    await this.emitByIds(userId, ids);
  }

  private async restoreGroupClaim(groupId: string): Promise<void> {
    await this.prisma.bracketGroup.updateMany({
      where: { id: groupId, status: 'pending_fire', leaseOwnerId: this.fireOwnerId },
      data: {
        status: 'working',
        fireLegId: null,
        leaseOwnerId: null,
        leaseExpiresAt: null,
      },
    });
  }

  private async emitByIds(userId: string, ids: string[]): Promise<void> {
    for (const id of ids) {
      const row = await this.byId(id);
      if (row) this.events.emit(userId, toChartOrder(row));
    }
  }

  /** Recovers bracket claims whose worker died around broker placement. The
   * order audit is the durable answer: completed audits finalize the group;
   * stale/missing claims replay the broker-idempotent placement. */
  async recoverPendingBrackets(now: Date): Promise<number> {
    const groups = await this.prisma.bracketGroup.findMany({
      where: { status: 'pending_fire', leaseExpiresAt: { lt: now } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    let recovered = 0;
    for (const group of groups) {
      const claimed = await this.prisma.bracketGroup.updateMany({
        where: { id: group.id, status: 'pending_fire', leaseExpiresAt: { lt: now } },
        data: {
          leaseOwnerId: this.fireOwnerId,
          leaseExpiresAt: new Date(now.getTime() + GROUP_FIRE_LEASE_MS),
        },
      });
      if (claimed.count !== 1 || !group.fireLegId) continue;
      const prepared = await this.prepareRecoveredClaim(group.fireLegId, group.id, now);
      if (!prepared) {
        await this.prisma.bracketGroup.updateMany({
          where: { id: group.id, leaseOwnerId: this.fireOwnerId },
          data: { status: 'failed', lastError: 'Fire leg cannot be recovered safely' },
        });
        continue;
      }
      const leg = prepared.leg;
      await this.emitByIds(leg.userId, prepared.siblingIds);
      const key = idempotencyKeyFor(leg.id);
      const audit = await this.prisma.orderAudit.findUnique({
        where: { userId_idempotencyKey: { userId: leg.userId, idempotencyKey: key } },
      });
      if (audit && audit.status !== 'pending' && audit.response) {
        await this.finishRecoveredGroup(group.id, leg, audit.response as unknown as OrderResult);
        recovered += 1;
        continue;
      }
      if (audit && now.getTime() - audit.createdAt.getTime() < PENDING_AUDIT_TTL_MS) continue;
      try {
        const placed = await this.trading.place(
          leg.userId,
          this.requestFor(leg, group.protectedQuantity),
          key,
          leg.environment as TradingMode,
          true,
        );
        await this.finishRecoveredGroup(group.id, leg, placed);
        recovered += 1;
      } catch (error) {
        if (error instanceof ApiException && error.code === 'ORDER_IN_FLIGHT') continue;
        const message = error instanceof Error ? error.message : String(error);
        await this.prisma.chartOrder.updateMany({
          where: { id: leg.id, status: 'pending_fire' },
          data: { status: 'failed', lastError: message.slice(0, 500) },
        });
        await this.prisma.chartOrder.updateMany({
          where: { ocoGroupId: group.id, status: 'cancelled' },
          data: { status: 'working' },
        });
        await this.prisma.bracketGroup.updateMany({
          where: { id: group.id, leaseOwnerId: this.fireOwnerId },
          data: {
            status: 'working',
            fireLegId: null,
            leaseOwnerId: null,
            leaseExpiresAt: null,
            lastError: message.slice(0, 500),
          },
        });
        this.events.emit(leg.userId, toChartOrder((await this.byId(leg.id)) ?? leg));
      }
    }
    return recovered;
  }

  /** Repairs claims produced by a worker that died between the pre-transaction
   * group update and the leg/sibling updates deployed by older versions. No
   * broker reconciliation or placement may start until this transaction has
   * made the firing leg non-working and retired every sibling. */
  private async prepareRecoveredClaim(
    legId: string,
    groupId: string,
    now: Date,
  ): Promise<{ leg: ChartOrderRow; siblingIds: string[] } | null> {
    return this.prisma.$transaction(async (database) => {
      let leg = await database.chartOrder.findUnique({ where: { id: legId } });
      if (!leg || leg.ocoGroupId !== groupId) return null;
      if (leg.status === 'working') {
        const claimed = await database.chartOrder.updateMany({
          where: {
            id: leg.id,
            ocoGroupId: groupId,
            userId: leg.userId,
            environment: leg.environment,
            status: 'working',
          },
          data: { status: 'pending_fire', triggeredAt: now, lastError: null },
        });
        if (claimed.count !== 1) return null;
        leg = await database.chartOrder.findUnique({ where: { id: legId } });
      }
      if (!leg || (leg.status !== 'pending_fire' && leg.status !== 'triggered')) return null;

      const siblings = await database.chartOrder.findMany({
        where: {
          ocoGroupId: groupId,
          userId: leg.userId,
          environment: leg.environment,
          NOT: { id: leg.id },
        },
      });
      await database.chartOrder.updateMany({
        where: {
          ocoGroupId: groupId,
          userId: leg.userId,
          environment: leg.environment,
          status: 'working',
          NOT: { id: leg.id },
        },
        data: { status: 'cancelled', triggeredAt: null },
      });
      return { leg, siblingIds: siblings.map((sibling) => sibling.id) };
    });
  }

  private requestFor(row: ChartOrderRow, protectedQuantity = row.quantity): OrderRequestDto {
    return {
      underlying: row.underlying,
      assetClass: 'option',
      side: row.side as OrderSide,
      quantity: protectedQuantity,
      orderType: row.orderType as ChartOrderType,
      selection: {
        mode: 'explicit',
        optionType: row.optionType as OptionType,
        expiration: row.expiration,
        strike: row.strike,
      },
    };
  }

  private async finishRecoveredGroup(
    groupId: string,
    leg: ChartOrderRow,
    placed: OrderResult,
  ): Promise<void> {
    await this.prisma.chartOrder.updateMany({
      where: { id: leg.id, status: 'pending_fire' },
      data: { status: 'triggered', brokerOrderId: placed.orderId },
    });
    await this.prisma.chartOrder.updateMany({
      where: { ocoGroupId: groupId, NOT: { id: leg.id }, status: 'working' },
      data: { status: 'cancelled' },
    });
    await this.prisma.bracketGroup.updateMany({
      where: { id: groupId, status: 'pending_fire', fireLegId: leg.id },
      data: {
        status: 'fired',
        leaseOwnerId: null,
        leaseExpiresAt: null,
        lastError: null,
      },
    });
    const updated = await this.byId(leg.id);
    if (updated) this.events.emit(leg.userId, toChartOrder(updated));
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
    openPositions: Array<string | { symbol: string; quantity: number }>,
    now: Date = new Date(),
  ): Promise<string[]> {
    const quantityBySymbol = new Map<string, number | null>();
    for (const position of openPositions) {
      if (typeof position === 'string') quantityBySymbol.set(position, null);
      else if (Number.isFinite(position.quantity) && position.quantity !== 0) {
        quantityBySymbol.set(position.symbol, Math.abs(position.quantity));
      }
    }

    // Scale every still-working sibling down before looking for orphans. The
    // group predicate serializes this against fire: if fire claimed first the
    // resize matches zero; if resize claimed first, fire reads the group's new
    // protected quantity even if it catches the leg updates in flight.
    const working = await this.prisma.chartOrder.findMany({
      where: {
        userId,
        environment,
        status: 'working',
        kind: { in: ['target', 'stop'] },
      },
    });
    const resizedGroups = new Set<string>();
    for (const row of working) {
      const held = quantityBySymbol.get(row.contractSymbol);
      if (held === undefined || held === null || held >= row.quantity) continue;
      if (row.ocoGroupId) {
        if (resizedGroups.has(row.ocoGroupId)) continue;
        const resized = await this.prisma.bracketGroup.updateMany({
          where: {
            id: row.ocoGroupId,
            userId,
            environment,
            status: 'working',
            protectedQuantity: { gt: held },
          },
          data: { protectedQuantity: held },
        });
        if (resized.count !== 1) continue;
        resizedGroups.add(row.ocoGroupId);
        const siblings = working.filter((candidate) => candidate.ocoGroupId === row.ocoGroupId);
        await this.prisma.chartOrder.updateMany({
          where: { ocoGroupId: row.ocoGroupId, userId, environment, status: 'working' },
          data: { quantity: held },
        });
        await this.emitByIds(
          userId,
          siblings.map((candidate) => candidate.id),
        );
      } else {
        const resized = await this.prisma.chartOrder.updateMany({
          where: { id: row.id, userId, environment, status: 'working', quantity: { gt: held } },
          data: { quantity: held },
        });
        if (resized.count === 1) await this.emitByIds(userId, [row.id]);
      }
    }

    const openContractSymbols = [...quantityBySymbol.keys()];
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
    // Compare-and-set per row, exactly as every other transition here does.
    // The read above and this write straddle an await, and a leg can be claimed
    // for firing in between — a stop firing IS what closes the position that
    // makes it look orphaned, so the two are correlated, not independent. A
    // blind update by id would stamp `cancelled` over a line whose order is
    // already at the broker, leaving a live order the chart calls cancelled.
    // Bounded by MAX_WORKING_CHART_ORDERS per user per sweep.
    const cancelled: string[] = [];
    for (const row of orphans) {
      const { count } = await this.prisma.chartOrder.updateMany({
        where: { id: row.id, status: 'working' },
        data: { status: 'cancelled' },
      });
      if (count === 1) cancelled.push(row.id);
    }
    return cancelled;
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

  private async ensureBracketGroup(
    userId: string,
    environment: string,
    dto: CreateChartOrderDto,
    contractSymbol: string,
    groupId: string,
    database: Prisma.TransactionClient,
  ): Promise<void> {
    const user = await database.user.findUnique({ where: { id: userId } });
    if (!user) throw errors.unauthorized('USER_NOT_FOUND', 'User no longer exists');
    const provider = user.tradingProvider;
    const connection =
      provider === 'snaptrade'
        ? await database.brokerConnection.findUnique({
            where: {
              userId_provider_environment: { userId, provider: 'snaptrade', environment },
            },
          })
        : null;
    const accountId = connection?.selectedAccountId ?? 'default';
    const group = await database.bracketGroup.upsert({
      where: { id: groupId },
      create: {
        id: groupId,
        userId,
        provider,
        environment,
        accountId,
        contractSymbol,
        closeSide: dto.side,
        protectedQuantity: dto.quantity,
      },
      update: {},
    });
    if (!group || group.userId !== userId) {
      throw errors.notFound('CHART_ORDER_NOT_FOUND', 'No such bracket group');
    }
    if (group.status !== 'working') {
      throw errors.conflict('OCO_GROUP_CLOSED', 'That bracket has already fired — draw a new one');
    }
    if (
      group.environment !== environment ||
      group.provider !== provider ||
      group.accountId !== accountId ||
      group.contractSymbol !== contractSymbol ||
      group.closeSide !== dto.side
    ) {
      throw errors.conflict(
        'OCO_GROUP_SCOPE_MISMATCH',
        'A bracket can only contain matching account, contract, side and environment legs',
      );
    }
    if (group.protectedQuantity !== dto.quantity) {
      throw errors.conflict(
        'OCO_GROUP_QUANTITY_MISMATCH',
        'Target and stop quantities must match; resize the existing bracket first',
      );
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
