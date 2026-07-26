import { Inject, Injectable } from '@nestjs/common';
import type { ChartOrder as ChartOrderRow } from '@prisma/client';
import {
  ChartOrder,
  ChartOrderKind,
  ChartOrderStatus,
  ChartOrderType,
  OptionType,
  OrderResult,
  OrderSide,
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
    if (dto.ocoGroupId) await this.assertGroupJoinable(userId, dto.ocoGroupId);

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

    // A patch that changes nothing must not write. `updatedAt` is load-bearing:
    // the watcher reads it to decide whether a line is newer than its last
    // observed price, and bumping it silently resets that line's crossing test
    // back to `armPrice`. An empty (or no-op) PATCH is a read, so answer it.
    if (Object.keys(data).length === 0) return toChartOrder(existing);

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
      quantity: fresh.quantity,
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
      placed = await this.trading.place(row.userId, request, idempotencyKeyFor(row.id));
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
  ): Promise<{ won: boolean; retired: string[] }> {
    if (!row.ocoGroupId) {
      return { won: await this.claimForFire(row.id, now), retired: [] };
    }
    // Scope every query in this claim to the owner and environment as well as
    // the group: a group id is client-supplied, and nothing should be able to
    // reach across accounts or across live/practice even if one leaks.
    const group = {
      ocoGroupId: row.ocoGroupId,
      userId: row.userId,
      environment: row.environment,
    };
    // The stamp is minted here, not taken from `now`: the watcher passes one
    // `now` to every fire in a tick, and the stamp has to identify THIS claim.
    const claimedAt = new Date();

    const claimed = await this.prisma.chartOrder.updateMany({
      where: { ...group, status: 'working' },
      data: { status: 'triggered', triggeredAt: claimedAt, lastError: null },
    });
    if (claimed.count === 0) return { won: false, retired: [] };

    // `status: triggered` + `triggeredAt: now` is this claim's token: together
    // they name exactly the rows this call took, and no concurrent caller can
    // share it (they matched nothing). Both halves are needed — a leg this
    // group already *failed* keeps its old `triggeredAt`, so matching on the
    // timestamp alone could reach across generations and retire it.
    const token = { ...group, status: 'triggered', triggeredAt: claimedAt };
    const self = await this.byId(row.id);
    if (self?.status !== 'triggered' || self.triggeredAt?.getTime() !== claimedAt.getTime()) {
      // Our own leg was not in the group's working set — it was cancelled or
      // already fired. Put back what we took instead of retiring a sibling that
      // is still legitimately armed.
      await this.prisma.chartOrder.updateMany({
        where: token,
        data: { status: 'working', triggeredAt: null },
      });
      return { won: false, retired: [] };
    }

    try {
      const siblings = await this.prisma.chartOrder.findMany({
        where: { ...token, NOT: { id: row.id } },
      });
      if (siblings.length > 0) {
        await this.prisma.chartOrder.updateMany({
          where: { ...token, NOT: { id: row.id } },
          data: { status: 'cancelled', triggeredAt: null },
        });
      }
      return { won: true, retired: siblings.map((sibling) => sibling.id) };
    } catch {
      // Retirement is what makes the claim safe, so a claim we cannot complete
      // must be given back. Leaving the group half-claimed would strand every
      // leg out of `working` with nothing sent and no path back: `update`,
      // `cancel`, the expiry sweep and the orphan sweep all require `working`.
      await this.prisma.chartOrder.updateMany({
        where: token,
        data: { status: 'working', triggeredAt: null },
      });
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

  private async emitByIds(userId: string, ids: string[]): Promise<void> {
    for (const id of ids) {
      const row = await this.byId(id);
      if (row) this.events.emit(userId, toChartOrder(row));
    }
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

  /**
   * A new leg may only join a bracket whose every existing leg is still armed.
   *
   * The group claim in `claimForFireWithSiblings` locks the rows that exist when
   * it runs; under READ COMMITTED it takes no gap lock, so a leg INSERTed
   * afterwards is a phantom it never saw. Both clients build a bracket as two
   * separate POSTs, and this one spends a chain fetch and a quote on the way in
   * — long enough for the first leg to fire in between. Without this check the
   * late leg lands `working` in a group that already fired, and firing it later
   * would close the position and then reverse it.
   */
  private async assertGroupJoinable(userId: string, ocoGroupId: string): Promise<void> {
    const existing = await this.prisma.chartOrder.findMany({ where: { ocoGroupId } });
    if (existing.some((leg) => leg.userId !== userId)) {
      throw errors.notFound('CHART_ORDER_NOT_FOUND', 'No such bracket group');
    }
    if (existing.some((leg) => leg.status !== 'working')) {
      throw errors.conflict('OCO_GROUP_CLOSED', 'That bracket has already fired — draw a new one');
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
