import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type BracketGroup, type ChartOrder as ChartOrderRow } from '@prisma/client';
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
import {
  BROKER_GATEWAY,
  BrokerExecutionScope,
  BrokerGateway,
} from '../broker/broker-gateway.interface';
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
const retirementMarker = (fireLegId: string): string => `Reserved by bracket fire ${fireLegId}`;
const PENDING_SCOPE_PREFIX = '__chart_order_execution_scope__:';

function executionScopeValue(value: unknown): BrokerExecutionScope | undefined {
  if (!value || Array.isArray(value) || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    !['webull', 'alpaca', 'snaptrade'].includes(String(candidate['provider'])) ||
    !['live', 'practice'].includes(String(candidate['environment'])) ||
    typeof candidate['accountId'] !== 'string' ||
    candidate['accountId'].length === 0
  ) {
    return undefined;
  }
  return candidate as unknown as BrokerExecutionScope;
}

function pendingScopeMarker(scope: BrokerExecutionScope): string {
  return `${PENDING_SCOPE_PREFIX}${JSON.stringify(scope)}`;
}

function scopeFromPendingMarker(value: string | null): BrokerExecutionScope | undefined {
  if (!value?.startsWith(PENDING_SCOPE_PREFIX)) return undefined;
  try {
    return executionScopeValue(JSON.parse(value.slice(PENDING_SCOPE_PREFIX.length)));
  } catch {
    return undefined;
  }
}

class BracketFireClaimLost extends Error {}
class BracketFinishClaimLost extends Error {}
class BracketNoSendClaimLost extends Error {}

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
    // The exact broker scope is persisted before an ungrouped placement so a
    // crash before its audit claim can still recover safely. It is internal
    // coordination metadata, not a user-facing error or account-id disclosure.
    lastError: scopeFromPendingMarker(row.lastError) ? null : row.lastError,
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
    if (dto.kind === 'limit' && dto.ocoGroupId) {
      throw errors.validation(
        'Standalone limit lines cannot join a protective target/stop bracket',
      );
    }
    await this.trading.assertCanArm(userId);
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
    // Protective target/stop lines must always carry an immutable broker and
    // account scope. Older clients may omit the group id for a one-leg stop;
    // give it a server-owned group rather than leaving an unattended close to
    // follow whichever broker account the user selects later.
    const requestedGroupId =
      dto.ocoGroupId ?? (dto.kind === 'target' || dto.kind === 'stop' ? randomUUID() : null);
    const scope = requestedGroupId
      ? await this.executionScopeFor(userId, environment as TradingMode)
      : null;
    let row: ChartOrderRow;
    try {
      const orderData = (ocoGroupId: string | null) => ({
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
        ocoGroupId,
        status: 'working',
        expiresAt,
      });
      row = requestedGroupId
        ? await this.prisma.$transaction(async (database) => {
            const groupId = await this.ensureBracketGroup(
              userId,
              scope!,
              dto,
              contract.symbol,
              requestedGroupId,
              database,
            );
            const existing = await database.chartOrder.findFirst({
              where: { ocoGroupId: groupId, kind: dto.kind },
            });
            if (existing) {
              if (existing.status !== 'failed' && existing.status !== 'cancelled') {
                throw errors.conflict(
                  'OCO_GROUP_DUPLICATE_KIND',
                  `That bracket already has a ${dto.kind} — move it instead of adding another`,
                );
              }
              // The unique key is intentionally permanent. Re-arm the same
              // durable leg instead of trying to insert a second row, and
              // clear every field from its previous firing generation so the
              // stable chart-order id/idempotency key is safe to reuse.
              const reactivated = await database.chartOrder.updateMany({
                where: {
                  id: existing.id,
                  userId,
                  ocoGroupId: groupId,
                  status: { in: ['failed', 'cancelled'] },
                },
                data: {
                  ...orderData(groupId),
                  triggeredAt: null,
                  brokerOrderId: null,
                  lastError: null,
                },
              });
              if (reactivated.count !== 1) {
                throw errors.conflict(
                  'OCO_GROUP_DUPLICATE_KIND',
                  `That bracket's ${dto.kind} changed while it was being re-armed`,
                );
              }
              return (await database.chartOrder.findUnique({ where: { id: existing.id } }))!;
            }
            return database.chartOrder.create({ data: orderData(groupId) });
          })
        : await this.prisma.chartOrder.create({ data: orderData(null) });
    } catch (error) {
      if (isUniqueViolation(error) && requestedGroupId) {
        throw errors.conflict(
          'OCO_GROUP_DUPLICATE_KIND',
          `That bracket already has a ${dto.kind} — move it instead of adding another`,
        );
      }
      throw error;
    }
    // Group membership and insertion share the same advisory lock as firing,
    // so no phantom leg can commit behind a group claim. Do not perform a
    // second group-status check after the transaction: a watcher may
    // legitimately claim the newly committed leg in that interval. Returning
    // that committed state is truthful and, critically, never reports a
    // conflict after a close may already be live at the broker.
    const committed = row.ocoGroupId ? ((await this.byId(row.id)) ?? row) : row;
    const created = toChartOrder(committed);
    this.events.emit(userId, created);
    return created;
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
    if (dto.orderType !== undefined && dto.orderType !== existing.orderType) {
      data.orderType = dto.orderType;
    }
    if (dto.quantity !== undefined && dto.quantity !== existing.quantity) {
      if (existing.ocoGroupId) {
        const resizedGroup = await this.prisma.$transaction(async (database) => {
          const group = await database.bracketGroup.findUnique({
            where: { id: existing.ocoGroupId! },
          });
          if (!group || group.userId !== userId) {
            throw errors.notFound('CHART_ORDER_NOT_FOUND', 'No such bracket group');
          }
          await this.lockBracketScope(database, group);
          const resized = await database.bracketGroup.updateMany({
            where: { id: existing.ocoGroupId!, userId, status: 'working' },
            data: { protectedQuantity: dto.quantity },
          });
          if (resized.count === 0) {
            throw errors.conflict('OCO_GROUP_CLOSED', 'That bracket is already firing');
          }
          await database.chartOrder.updateMany({
            where: { ocoGroupId: existing.ocoGroupId!, userId, status: 'working' },
            data: { quantity: dto.quantity },
          });
          const updated = await database.chartOrder.updateMany({
            where: { id, userId, status: 'working' },
            data,
          });
          if (updated.count !== 1) {
            throw errors.conflict(
              'CHART_ORDER_NOT_WORKING',
              'This order just fired and can no longer be changed',
            );
          }
          const legs = await database.chartOrder.findMany({
            where: { ocoGroupId: existing.ocoGroupId!, userId, status: 'working' },
          });
          return {
            order: toChartOrder(
              (await database.chartOrder.findUnique({ where: { id } })) as ChartOrderRow,
            ),
            legIds: legs.map((leg) => leg.id),
          };
        });
        await this.emitByIds(userId, resizedGroup.legIds);
        return resizedGroup.order;
      } else {
        data.quantity = dto.quantity;
      }
    }

    // A patch that changes nothing must not write. `updatedAt` is load-bearing:
    // the watcher reads it to decide whether a line is newer than its last
    // observed price, and bumping it silently resets that line's crossing test
    // back to `armPrice`. An empty (or no-op) PATCH is a read, so answer it.
    if (Object.keys(data).length === 0) {
      return toChartOrder(existing);
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
    const result = toChartOrder(await this.findOwned(userId, id));
    this.events.emit(userId, result);
    return result;
  }

  /** Cancels a working line. Nothing was ever sent to the broker. */
  async cancel(userId: string, id: string): Promise<void> {
    const existing = await this.findOwned(userId, id);
    if (existing.ocoGroupId) {
      await this.prisma.$transaction(async (database) => {
        const group = await database.bracketGroup.findUnique({
          where: { id: existing.ocoGroupId! },
        });
        if (!group || group.userId !== userId) {
          throw errors.notFound('CHART_ORDER_NOT_FOUND', 'No such chart order');
        }
        await this.lockBracketScope(database, group);
        const lockedGroup = await database.bracketGroup.findUnique({ where: { id: group.id } });
        if (!lockedGroup || lockedGroup.status !== 'working') {
          throw errors.conflict(
            'CHART_ORDER_NOT_WORKING',
            'This bracket already started firing and cannot be cancelled here',
          );
        }
        const cancelled = await database.chartOrder.updateMany({
          where: {
            id,
            userId,
            ocoGroupId: group.id,
            status: 'working',
          },
          data: { status: 'cancelled', lastError: null },
        });
        if (cancelled.count !== 1) {
          throw errors.conflict(
            'CHART_ORDER_NOT_WORKING',
            'This order already fired and cannot be cancelled here',
          );
        }
        await this.closeWorkingGroupIfEmpty(database, lockedGroup, 'All bracket legs cancelled');
      });
    } else {
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
    await this.emitByIds(userId, [id]);
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
  async claimForFire(
    id: string,
    now: Date,
    expectedScope?: BrokerExecutionScope,
  ): Promise<boolean> {
    const claimed = await this.prisma.chartOrder.updateMany({
      where: { id, status: 'working' },
      data: {
        status: 'pending_fire',
        triggeredAt: now,
        lastError: expectedScope ? pendingScopeMarker(expectedScope) : null,
      },
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
    let scopeMatches = row.environment === environment;
    if (scopeMatches && claim.expectedScope) {
      try {
        const current = await this.executionScopeFor(row.userId, row.environment as TradingMode);
        scopeMatches =
          current.provider === claim.expectedScope.provider &&
          current.environment === claim.expectedScope.environment &&
          current.accountId === claim.expectedScope.accountId;
      } catch {
        scopeMatches = false;
      }
    }
    if (!scopeMatches) {
      if (row.ocoGroupId) {
        const unclaimed = await this.settleGroupedNoSend(
          row,
          claim.retired,
          'working',
          null,
          'Bracket fire was unclaimed before broker placement',
        );
        return toChartOrder(unclaimed ?? (await this.byId(row.id)) ?? row);
      }
      return toChartOrder(
        await this.prisma.chartOrder.update({
          where: { id: row.id },
          data: { status: 'working', triggeredAt: null, lastError: null },
        }),
      );
    }

    // A settled contract cannot be traded; retire the line instead of letting
    // a client fire it in the window before the watcher's expiry sweep.
    if (row.expiresAt.getTime() <= now.getTime()) {
      if (row.ocoGroupId) {
        const expired = await this.settleGroupedNoSend(
          row,
          claim.retired,
          'expired',
          null,
          'All bracket legs expired before broker placement',
        );
        return toChartOrder(expired ?? (await this.byId(row.id)) ?? row);
      }
      const expired = toChartOrder(
        await this.prisma.chartOrder.update({
          where: { id: row.id },
          data: { status: 'expired', lastError: null },
        }),
      );
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
        claim.expectedScope,
      );
    } catch (err) {
      // The broker may have accepted an order whose acknowledgement was lost,
      // or another caller may still hold this same durable key. Preserve the
      // group reservation and retired sibling until recovery can prove the
      // outcome; re-arming here could submit the opposite leg as a second close.
      if (this.isUncertainFireError(err)) {
        const message = err instanceof Error ? err.message : String(err);
        await this.prisma.chartOrder
          .updateMany({
            where: { id: row.id, status: 'pending_fire' },
            data: { lastError: message.slice(0, 500) },
          })
          .catch(() => undefined);
        if (row.ocoGroupId) {
          await this.prisma.bracketGroup
            .updateMany({
              where: {
                id: row.ocoGroupId,
                status: 'pending_fire',
                fireLegId: row.id,
              },
              data: {
                leaseExpiresAt: new Date(Date.now() + GROUP_FIRE_LEASE_MS),
                lastError: message.slice(0, 500),
              },
            })
            .catch(() => undefined);
        }
        return toChartOrder((await this.byId(row.id)) ?? row);
      }
      const message = err instanceof Error ? err.message : String(err);
      if (row.ocoGroupId) {
        const failed = await this.settleGroupedNoSend(
          row,
          claim.retired,
          'failed',
          message.slice(0, 500),
          'Bracket fire was rejected before broker acceptance',
        );
        return toChartOrder(failed ?? (await this.byId(row.id)) ?? row);
      }
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
    if (row.ocoGroupId) {
      try {
        if (await this.finishRecoveredGroup(row.ocoGroupId, fresh, placed)) {
          return toChartOrder((await this.byId(row.id)) ?? fresh);
        }
      } catch {
        // Keep the durable pending claim below. The completed order audit lets
        // the recovery worker finalize it without placing a second order.
      }

      const message = 'Broker accepted the order; awaiting durable bracket finalization';
      await this.prisma.chartOrder
        .updateMany({
          where: { id: row.id, ocoGroupId: row.ocoGroupId, status: 'pending_fire' },
          data: { lastError: message },
        })
        .catch(() => undefined);
      await this.prisma.bracketGroup
        .updateMany({
          where: {
            id: row.ocoGroupId,
            fireLegId: row.id,
            status: 'pending_fire',
            leaseOwnerId: this.fireOwnerId,
          },
          data: {
            leaseExpiresAt: new Date(Date.now() + GROUP_FIRE_LEASE_MS),
            lastError: message,
          },
        })
        .catch(() => undefined);
      const pending = toChartOrder((await this.byId(row.id)) ?? fresh);
      this.events.emit(row.userId, pending);
      return pending;
    }

    let updated: ChartOrder;
    try {
      updated = toChartOrder(
        await this.prisma.chartOrder.update({
          where: { id: row.id },
          data: { status: 'triggered', brokerOrderId: placed.orderId, lastError: null },
        }),
      );
    } catch {
      // Ungrouped limits have no second close leg to reserve. Report the known
      // broker acceptance even if recording its id has to be repaired later.
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
  ): Promise<{
    won: boolean;
    retired: string[];
    protectedQuantity?: number;
    expectedScope?: BrokerExecutionScope;
  }> {
    if (!row.ocoGroupId) {
      let expectedScope: BrokerExecutionScope;
      try {
        expectedScope = await this.executionScopeFor(row.userId, row.environment as TradingMode);
      } catch {
        return { won: false, retired: [] };
      }
      return {
        won: await this.claimForFire(row.id, now, expectedScope),
        retired: [],
        expectedScope,
      };
    }
    try {
      return await this.prisma.$transaction(async (database) => {
        const existingGroup = await database.bracketGroup.findUnique({
          where: { id: row.ocoGroupId! },
        });
        if (
          !existingGroup ||
          existingGroup.userId !== row.userId ||
          existingGroup.environment !== row.environment ||
          !['webull', 'alpaca', 'snaptrade'].includes(existingGroup.provider)
        ) {
          return { won: false, retired: [] };
        }
        await this.lockBracketScope(database, existingGroup);
        const expectedScope: BrokerExecutionScope = {
          provider: existingGroup.provider as BrokerExecutionScope['provider'],
          environment: existingGroup.environment as TradingMode,
          accountId: existingGroup.accountId,
        };
        if (
          await this.hasUnresolvedCloseReservation(
            database,
            expectedScope,
            row.userId,
            existingGroup.contractSymbol,
            existingGroup.closeSide,
            existingGroup.id,
          )
        ) {
          return { won: false, retired: [] };
        }
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
            data: {
              status: 'cancelled',
              triggeredAt: null,
              lastError: retirementMarker(row.id),
            },
          });
        }
        return {
          won: true,
          retired: siblings.map((sibling) => sibling.id),
          protectedQuantity: claimedGroup?.protectedQuantity,
          expectedScope,
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

  private isUncertainFireError(error: unknown): boolean {
    return (
      error instanceof ApiException &&
      [
        'ORDER_IN_FLIGHT',
        'ORDER_PLACEMENT_UNCERTAIN',
        'ORDER_RECOVERY_AMBIGUOUS',
        'ORDER_RECOVERY_UNAVAILABLE',
      ].includes(error.code)
    );
  }

  /** Atomically unwinds a grouped claim when broker placement provably did not
   * happen. The fire leg, its system-retired siblings, and the group lease are
   * one database fact: a crash must leave either the durable pending claim for
   * recovery or the fully restored bracket, never a half-restored close path. */
  private async settleGroupedNoSend(
    row: ChartOrderRow,
    retiredIds: string[],
    legStatus: 'working' | 'failed' | 'expired',
    lastError: string | null,
    emptyGroupReason: string,
  ): Promise<ChartOrderRow | null> {
    const uniqueRetiredIds = [...new Set(retiredIds)];
    let result: { updated: ChartOrderRow; restoredIds: string[] };
    try {
      result = await this.prisma.$transaction(async (database) => {
        const group = row.ocoGroupId
          ? await database.bracketGroup.findUnique({ where: { id: row.ocoGroupId } })
          : null;
        if (!group || group.userId !== row.userId) throw new BracketNoSendClaimLost();
        await this.lockBracketScope(database, group);

        const restorable =
          uniqueRetiredIds.length === 0
            ? []
            : await database.chartOrder.findMany({
                where: {
                  id: { in: uniqueRetiredIds },
                  userId: row.userId,
                  ocoGroupId: group.id,
                  status: 'cancelled',
                  lastError: retirementMarker(row.id),
                },
              });
        if (restorable.length !== uniqueRetiredIds.length) {
          throw new BracketNoSendClaimLost();
        }

        const leg = await database.chartOrder.updateMany({
          where: {
            id: row.id,
            userId: row.userId,
            ocoGroupId: group.id,
            status: { in: ['pending_fire', 'triggered'] },
          },
          data: {
            status: legStatus,
            lastError,
            ...(legStatus === 'working' ? { triggeredAt: null } : {}),
          },
        });
        if (leg.count !== 1) throw new BracketNoSendClaimLost();

        if (restorable.length > 0) {
          const restored = await database.chartOrder.updateMany({
            where: {
              id: { in: restorable.map((sibling) => sibling.id) },
              userId: row.userId,
              ocoGroupId: group.id,
              status: 'cancelled',
              lastError: retirementMarker(row.id),
            },
            data: { status: 'working', triggeredAt: null, lastError: null },
          });
          if (restored.count !== restorable.length) throw new BracketNoSendClaimLost();
        }

        const released = await database.bracketGroup.updateMany({
          where: {
            id: group.id,
            userId: row.userId,
            status: 'pending_fire',
            fireLegId: row.id,
            leaseOwnerId: this.fireOwnerId,
          },
          data: {
            status: 'working',
            fireLegId: null,
            leaseOwnerId: null,
            leaseExpiresAt: null,
            lastError,
          },
        });
        if (released.count !== 1) throw new BracketNoSendClaimLost();
        await this.closeWorkingGroupIfEmpty(database, group, emptyGroupReason);

        const updated = await database.chartOrder.findUnique({ where: { id: row.id } });
        if (!updated) throw new BracketNoSendClaimLost();
        return { updated, restoredIds: restorable.map((sibling) => sibling.id) };
      });
    } catch (error) {
      if (error instanceof BracketNoSendClaimLost) return null;
      throw error;
    }
    await this.emitByIds(row.userId, result.restoredIds);
    this.events.emit(row.userId, toChartOrder(result.updated));
    return result.updated;
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
    let recovered = await this.recoverPendingUngrouped(now);
    const groups = await this.prisma.bracketGroup.findMany({
      where: { status: 'pending_fire', leaseExpiresAt: { lt: now } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
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
        if (
          await this.finishRecoveredGroup(group.id, leg, audit.response as unknown as OrderResult)
        ) {
          recovered += 1;
        }
        continue;
      }
      if (audit && now.getTime() - audit.createdAt.getTime() < PENDING_AUDIT_TTL_MS) continue;
      const expectedScope: BrokerExecutionScope = {
        provider: group.provider as BrokerExecutionScope['provider'],
        environment: group.environment as TradingMode,
        accountId: group.accountId,
      };
      try {
        const currentScope = await this.executionScopeFor(
          leg.userId,
          leg.environment as TradingMode,
        );
        if (
          currentScope.provider !== expectedScope.provider ||
          currentScope.environment !== expectedScope.environment ||
          currentScope.accountId !== expectedScope.accountId
        ) {
          throw errors.conflict(
            'OCO_GROUP_SCOPE_MISMATCH',
            'Broker provider or selected account changed while this bracket was armed',
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.prisma.bracketGroup.updateMany({
          where: { id: group.id, status: 'pending_fire', leaseOwnerId: this.fireOwnerId },
          data: {
            leaseExpiresAt: new Date(now.getTime() + GROUP_FIRE_LEASE_MS),
            lastError: message.slice(0, 500),
          },
        });
        continue;
      }
      try {
        const placed = await this.trading.place(
          leg.userId,
          this.requestFor(leg, group.protectedQuantity),
          key,
          leg.environment as TradingMode,
          true,
          expectedScope,
        );
        if (await this.finishRecoveredGroup(group.id, leg, placed)) recovered += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.isUncertainFireError(error)) {
          await this.prisma.chartOrder.updateMany({
            where: { id: leg.id, status: { in: ['pending_fire', 'triggered'] } },
            data: { lastError: message.slice(0, 500) },
          });
          await this.prisma.bracketGroup.updateMany({
            where: { id: group.id, status: 'pending_fire', leaseOwnerId: this.fireOwnerId },
            data: {
              leaseExpiresAt: new Date(now.getTime() + GROUP_FIRE_LEASE_MS),
              lastError: message.slice(0, 500),
            },
          });
          continue;
        }
        await this.settleGroupedNoSend(
          leg,
          prepared.siblingIds,
          'failed',
          message.slice(0, 500),
          'Recovered bracket fire was rejected before broker acceptance',
        );
      }
    }
    return recovered;
  }

  /** Standalone chart lines have no BracketGroup lease, but they still need
   * the same durable pending state as protective legs. `triggeredAt` is their
   * recovery lease: one instance compare-and-sets the stale value, then the
   * keyed order audit either proves acceptance or serializes the retry. */
  private async recoverPendingUngrouped(now: Date): Promise<number> {
    const staleBefore = new Date(now.getTime() - PENDING_AUDIT_TTL_MS);
    const candidates = await this.prisma.chartOrder.findMany({
      where: {
        ocoGroupId: null,
        status: 'pending_fire',
        triggeredAt: { lt: staleBefore },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    let recovered = 0;
    for (const candidate of candidates) {
      if (!candidate.triggeredAt) continue;
      const claimed = await this.prisma.chartOrder.updateMany({
        where: {
          id: candidate.id,
          userId: candidate.userId,
          ocoGroupId: null,
          status: 'pending_fire',
          triggeredAt: candidate.triggeredAt,
        },
        data: { triggeredAt: now },
      });
      if (claimed.count !== 1) continue;

      const key = idempotencyKeyFor(candidate.id);
      let audit = await this.prisma.orderAudit.findUnique({
        where: {
          userId_idempotencyKey: {
            userId: candidate.userId,
            idempotencyKey: key,
          },
        },
      });
      const completed = this.orderResultFromAudit(audit?.status, audit?.response);
      if (completed) {
        if (await this.finishUngroupedFire(candidate, now, completed)) recovered += 1;
        continue;
      }

      const expectedScope =
        this.executionScopeFromAudit(audit?.request) ?? scopeFromPendingMarker(candidate.lastError);
      if (!expectedScope) {
        await this.prisma.chartOrder.updateMany({
          where: { id: candidate.id, status: 'pending_fire', triggeredAt: now },
          data: {
            lastError:
              'Placement recovery is paused because its original broker account scope is unavailable',
          },
        });
        continue;
      }

      try {
        const placed = await this.trading.place(
          candidate.userId,
          this.requestFor(candidate),
          key,
          candidate.environment as TradingMode,
          candidate.kind === 'target' || candidate.kind === 'stop',
          expectedScope,
        );
        if (await this.finishUngroupedFire(candidate, now, placed)) recovered += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        audit = await this.prisma.orderAudit.findUnique({
          where: {
            userId_idempotencyKey: {
              userId: candidate.userId,
              idempotencyKey: key,
            },
          },
        });
        const accepted = this.orderResultFromAudit(audit?.status, audit?.response);
        if (accepted) {
          if (await this.finishUngroupedFire(candidate, now, accepted)) recovered += 1;
          continue;
        }
        if (!audit) {
          const failed = await this.prisma.chartOrder.updateMany({
            where: { id: candidate.id, status: 'pending_fire', triggeredAt: now },
            data: { status: 'failed', lastError: message.slice(0, 500) },
          });
          if (failed.count === 1) await this.emitByIds(candidate.userId, [candidate.id]);
          continue;
        }
        // A pending audit means an earlier broker send may still have been
        // accepted. Even legal/kill-switch changes and typed pre-send errors
        // cannot disprove that older placement, so preserve the reservation.
        await this.prisma.chartOrder.updateMany({
          where: { id: candidate.id, status: 'pending_fire', triggeredAt: now },
          data: { lastError: message.slice(0, 500) },
        });
      }
    }
    return recovered;
  }

  private async finishUngroupedFire(
    row: ChartOrderRow,
    leaseTime: Date,
    placed: OrderResult,
  ): Promise<boolean> {
    const finished = await this.prisma.chartOrder.updateMany({
      where: {
        id: row.id,
        userId: row.userId,
        ocoGroupId: null,
        status: 'pending_fire',
        triggeredAt: leaseTime,
      },
      data: {
        status: 'triggered',
        brokerOrderId: placed.orderId,
        lastError: null,
      },
    });
    if (finished.count !== 1) return false;
    await this.emitByIds(row.userId, [row.id]);
    return true;
  }

  private orderResultFromAudit(
    status: string | undefined,
    response: Prisma.JsonValue | null | undefined,
  ): OrderResult | null {
    if (!status || status === 'pending' || !response || typeof response !== 'object') return null;
    const candidate = response as unknown as Partial<OrderResult>;
    if (typeof candidate.orderId !== 'string' || candidate.orderId.length === 0) return null;
    return candidate as OrderResult;
  }

  private executionScopeFromAudit(
    request: Prisma.JsonValue | null | undefined,
  ): BrokerExecutionScope | undefined {
    if (!request || Array.isArray(request) || typeof request !== 'object') return undefined;
    return executionScopeValue((request as Prisma.JsonObject)['executionScope']);
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
        data: {
          status: 'cancelled',
          triggeredAt: null,
          lastError: retirementMarker(leg.id),
        },
      });
      return {
        leg,
        siblingIds: siblings
          .filter(
            (sibling) =>
              sibling.status === 'working' ||
              (sibling.status === 'cancelled' && sibling.lastError === retirementMarker(leg.id)),
          )
          .map((sibling) => sibling.id),
      };
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
  ): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (database) => {
        const group = await database.bracketGroup.findUnique({ where: { id: groupId } });
        if (!group) throw new BracketFinishClaimLost();
        await this.lockBracketScope(database, group);
        const updatedLeg = await database.chartOrder.updateMany({
          where: {
            id: leg.id,
            userId: leg.userId,
            ocoGroupId: groupId,
            status: { in: ['pending_fire', 'triggered'] },
          },
          data: { status: 'triggered', brokerOrderId: placed.orderId },
        });
        if (updatedLeg.count !== 1) throw new BracketFinishClaimLost();
        await database.chartOrder.updateMany({
          where: {
            ocoGroupId: groupId,
            userId: leg.userId,
            NOT: { id: leg.id },
            OR: [
              { status: 'working' },
              { status: 'cancelled', lastError: retirementMarker(leg.id) },
            ],
          },
          data: { status: 'cancelled', lastError: null },
        });
        const finished = await database.bracketGroup.updateMany({
          where: {
            id: groupId,
            userId: leg.userId,
            status: 'pending_fire',
            fireLegId: leg.id,
            leaseOwnerId: this.fireOwnerId,
          },
          data: {
            status: 'fired',
            leaseOwnerId: null,
            leaseExpiresAt: null,
            lastError: null,
          },
        });
        if (finished.count !== 1) throw new BracketFinishClaimLost();
      });
    } catch (error) {
      if (error instanceof BracketFinishClaimLost) return false;
      throw error;
    }
    const updated = await this.byId(leg.id);
    if (updated) this.events.emit(leg.userId, toChartOrder(updated));
    return true;
  }

  /** Retires working lines whose contract has settled. */
  async expireSettled(now: Date): Promise<number> {
    const candidates = await this.prisma.chartOrder.findMany({
      where: { status: 'working', expiresAt: { lte: now } },
    });
    let expired = 0;
    for (const candidate of candidates) {
      const changed = candidate.ocoGroupId
        ? await this.prisma.$transaction(async (database) => {
            const group = await database.bracketGroup.findUnique({
              where: { id: candidate.ocoGroupId! },
            });
            if (!group || group.userId !== candidate.userId) return false;
            await this.lockBracketScope(database, group);
            const { count } = await database.chartOrder.updateMany({
              where: {
                id: candidate.id,
                userId: candidate.userId,
                ocoGroupId: group.id,
                status: 'working',
                expiresAt: { lte: now },
              },
              data: { status: 'expired' },
            });
            if (count !== 1) return false;
            await this.closeWorkingGroupIfEmpty(database, group, 'All bracket legs expired');
            return true;
          })
        : (
            await this.prisma.chartOrder.updateMany({
              where: { id: candidate.id, status: 'working', expiresAt: { lte: now } },
              data: { status: 'expired' },
            })
          ).count === 1;
      if (!changed) continue;
      expired += 1;
      const updated = await this.byId(candidate.id);
      if (updated) this.events.emit(updated.userId, toChartOrder(updated));
    }
    return expired;
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
    positionScope?: BrokerExecutionScope,
  ): Promise<string[]> {
    let scope: BrokerExecutionScope;
    try {
      const current = await this.executionScopeFor(userId, environment as TradingMode);
      if (
        positionScope &&
        (current.provider !== positionScope.provider ||
          current.environment !== positionScope.environment ||
          current.accountId !== positionScope.accountId)
      ) {
        return [];
      }
      scope = positionScope ?? current;
    } catch {
      // A sweep without a verified account scope could cancel protection that
      // belongs to another selected brokerage account. Fail closed.
      return [];
    }
    const scopedGroups = await this.prisma.bracketGroup.findMany({
      where: {
        userId,
        provider: scope.provider,
        environment: scope.environment,
        accountId: scope.accountId,
        status: 'working',
      },
    });
    const scopedGroupIds = scopedGroups.map((group) => group.id);
    const scopedBracketRows = {
      OR: [{ ocoGroupId: null }, { ocoGroupId: { in: scopedGroupIds } }],
    };
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
        ...scopedBracketRows,
      },
    });
    const resizedGroups = new Set<string>();
    for (const row of working) {
      const held = quantityBySymbol.get(row.contractSymbol);
      if (held === undefined || held === null || held >= row.quantity) continue;
      if (row.ocoGroupId) {
        if (resizedGroups.has(row.ocoGroupId)) continue;
        const resized = await this.prisma.$transaction(async (database) => {
          const group = await database.bracketGroup.findUnique({
            where: { id: row.ocoGroupId! },
          });
          if (!group) return false;
          await this.lockBracketScope(database, group);
          const changed = await database.bracketGroup.updateMany({
            where: {
              id: row.ocoGroupId!,
              userId,
              provider: scope.provider,
              environment,
              accountId: scope.accountId,
              status: 'working',
              protectedQuantity: { gt: held },
            },
            data: { protectedQuantity: held },
          });
          if (changed.count !== 1) return false;
          await database.chartOrder.updateMany({
            where: { ocoGroupId: row.ocoGroupId!, userId, environment, status: 'working' },
            data: { quantity: held },
          });
          return true;
        });
        if (!resized) continue;
        resizedGroups.add(row.ocoGroupId);
        const siblings = working.filter((candidate) => candidate.ocoGroupId === row.ocoGroupId);
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
        ...scopedBracketRows,
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
      const changed = row.ocoGroupId
        ? await this.prisma.$transaction(async (database) => {
            const group = await database.bracketGroup.findUnique({
              where: { id: row.ocoGroupId! },
            });
            if (
              !group ||
              group.userId !== userId ||
              group.provider !== scope.provider ||
              group.environment !== scope.environment ||
              group.accountId !== scope.accountId
            ) {
              return false;
            }
            await this.lockBracketScope(database, group);
            const { count } = await database.chartOrder.updateMany({
              where: {
                id: row.id,
                userId,
                ocoGroupId: group.id,
                status: 'working',
              },
              data: { status: 'cancelled', lastError: null },
            });
            if (count !== 1) return false;
            await this.closeWorkingGroupIfEmpty(
              database,
              group,
              'All bracket legs orphaned from the broker position',
            );
            return true;
          })
        : (
            await this.prisma.chartOrder.updateMany({
              where: { id: row.id, status: 'working' },
              data: { status: 'cancelled' },
            })
          ).count === 1;
      if (!changed) continue;
      cancelled.push(row.id);
      await this.emitByIds(userId, [row.id]);
    }
    return cancelled;
  }

  byId(id: string): Promise<ChartOrderRow | null> {
    return this.prisma.chartOrder.findUnique({ where: { id } });
  }

  /** Pins a positions reconciliation sweep to the exact broker account whose
   * positions it will read. The sweep verifies the same scope again before it
   * mutates any bracket, closing the account-switch window around the read. */
  reconciliationScope(userId: string, environment: string): Promise<BrokerExecutionScope> {
    return this.executionScopeFor(userId, environment as TradingMode);
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

  private async executionScopeFor(
    userId: string,
    environment: TradingMode,
  ): Promise<BrokerExecutionScope> {
    if (this.gateway.executionScope) {
      return this.gateway.executionScope(userId, environment);
    }
    // Conservative compatibility path for test/legacy gateways. Production
    // gateways expose executionScope so Webull's discovered account id and
    // SnapTrade's selected account are both represented exactly.
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw errors.unauthorized('USER_NOT_FOUND', 'User no longer exists');
    const provider: BrokerExecutionScope['provider'] =
      user.tradingProvider === 'alpaca' || user.tradingProvider === 'snaptrade'
        ? user.tradingProvider
        : 'webull';
    const current: TradingMode = user.tradingMode === 'practice' ? 'practice' : 'live';
    if (current !== environment) {
      throw errors.conflict(
        'OCO_GROUP_SCOPE_MISMATCH',
        `Account switched to ${current}; this bracket belongs to ${environment}`,
      );
    }
    const connection =
      provider === 'snaptrade'
        ? await this.prisma.brokerConnection.findUnique({
            where: {
              userId_provider_environment: {
                userId,
                provider: 'snaptrade',
                environment,
              },
            },
          })
        : null;
    return {
      provider,
      environment,
      accountId: connection?.selectedAccountId ?? 'default',
    };
  }

  /** Cross-instance mutex for one position's close path. The SHA-256 input is
   * a JSON tuple, so concatenation ambiguities cannot make unrelated accounts
   * share or evade a lock. Postgres holds it until this transaction ends. */
  private async lockBracketScope(
    database: Prisma.TransactionClient,
    group: Pick<
      BracketGroup,
      'userId' | 'provider' | 'environment' | 'accountId' | 'contractSymbol' | 'closeSide'
    >,
  ): Promise<void> {
    const raw = database as unknown as {
      $executeRaw?: (query: Prisma.Sql) => Promise<number>;
    };
    if (!raw.$executeRaw) return; // in-memory test transaction is already serial
    const tuple = JSON.stringify([
      group.userId,
      group.provider,
      group.environment,
      group.accountId,
      group.contractSymbol,
      group.closeSide,
    ]);
    const unsigned = BigInt(`0x${createHash('sha256').update(tuple).digest('hex').slice(0, 16)}`);
    const signed = unsigned >= 2n ** 63n ? unsigned - 2n ** 64n : unsigned;
    await raw.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${signed})`);
  }

  private async closeWorkingGroupIfEmpty(
    database: Prisma.TransactionClient,
    group: Pick<BracketGroup, 'id' | 'userId'>,
    reason: string,
  ): Promise<boolean> {
    const active = await database.chartOrder.count({
      where: {
        ocoGroupId: group.id,
        userId: group.userId,
        status: { in: ['working', 'pending_fire', 'triggered'] },
      },
    });
    if (active !== 0) return false;
    const closed = await database.bracketGroup.updateMany({
      where: { id: group.id, userId: group.userId, status: 'working' },
      data: {
        status: 'closed',
        fireLegId: null,
        leaseOwnerId: null,
        leaseExpiresAt: null,
        lastError: reason.slice(0, 500),
      },
    });
    return closed.count === 1;
  }

  private async hasUnresolvedCloseReservation(
    database: Prisma.TransactionClient,
    scope: BrokerExecutionScope,
    userId: string,
    contractSymbol: string,
    closeSide: string,
    excludeGroupId?: string,
  ): Promise<boolean> {
    const groups = await database.bracketGroup.findMany({
      where: {
        userId,
        provider: scope.provider,
        environment: scope.environment,
        accountId: scope.accountId,
        contractSymbol,
        closeSide,
        status: { in: ['pending_fire', 'fired'] },
      },
    });
    for (const group of groups) {
      if (group.id === excludeGroupId) continue;
      if (group.status === 'pending_fire' || !group.fireLegId) return true;
      const leg = await database.chartOrder.findUnique({ where: { id: group.fireLegId } });
      if (!leg?.brokerOrderId) return true;
      const orders = await database.tradeOrder.findMany({
        where: {
          userId,
          provider: scope.provider,
          environment: scope.environment,
          accountId: scope.accountId,
          OR: [{ brokerOrderId: leg.brokerOrderId }, { clientOrderId: leg.brokerOrderId }],
        },
      });
      // Missing persistence is conservatively in-flight. Partial fills retain
      // the reservation; only a broker-terminal row releases it.
      if (
        orders.length === 0 ||
        orders.some((order) => !['filled', 'cancelled', 'rejected'].includes(order.status))
      ) {
        return true;
      }
    }
    return false;
  }

  private async ensureBracketGroup(
    userId: string,
    scope: BrokerExecutionScope,
    dto: CreateChartOrderDto,
    contractSymbol: string,
    groupId: string,
    database: Prisma.TransactionClient,
  ): Promise<string> {
    const expected = {
      userId,
      provider: scope.provider,
      environment: scope.environment,
      accountId: scope.accountId,
      contractSymbol,
      closeSide: dto.side,
    };
    await this.lockBracketScope(database, expected);

    const requested = await database.bracketGroup.findUnique({ where: { id: groupId } });
    if (requested && requested.userId !== userId) {
      throw errors.notFound('CHART_ORDER_NOT_FOUND', 'No such bracket group');
    }
    if (requested && this.bracketScopeDiffers(requested, expected)) {
      throw errors.conflict(
        'OCO_GROUP_SCOPE_MISMATCH',
        'A bracket can only contain matching account, contract, side and environment legs',
      );
    }
    if (requested && !['working', 'closed'].includes(requested.status)) {
      throw errors.conflict('OCO_GROUP_CLOSED', 'That bracket has already fired — draw a new one');
    }
    if (
      await this.hasUnresolvedCloseReservation(
        database,
        scope,
        userId,
        contractSymbol,
        dto.side,
        requested?.id,
      )
    ) {
      throw errors.conflict(
        'OCO_CLOSE_IN_FLIGHT',
        'Another close for this position is still in flight at the broker',
      );
    }

    // A position has one active protection group per exact brokerage scope.
    // Returning the canonical id makes independently connected clients
    // converge even when they generated different UUIDs.
    const canonical = await database.bracketGroup.findFirst({
      where: { ...expected, status: 'working' },
      orderBy: { createdAt: 'asc' },
    });
    let reopened: BracketGroup | null = null;
    if (!canonical && requested?.status === 'closed') {
      const active = await database.chartOrder.count({
        where: {
          ocoGroupId: requested.id,
          userId,
          status: { in: ['working', 'pending_fire', 'triggered'] },
        },
      });
      if (active !== 0) {
        throw errors.conflict(
          'OCO_GROUP_CLOSED',
          'That bracket cannot be re-armed while an earlier close may still be active',
        );
      }
      const changed = await database.bracketGroup.updateMany({
        where: { id: requested.id, userId, status: 'closed' },
        data: {
          status: 'working',
          protectedQuantity: dto.quantity,
          fireLegId: null,
          leaseOwnerId: null,
          leaseExpiresAt: null,
          lastError: null,
        },
      });
      if (changed.count !== 1) {
        throw errors.conflict('OCO_GROUP_CLOSED', 'That bracket changed while being re-armed');
      }
      reopened = await database.bracketGroup.findUnique({ where: { id: requested.id } });
      if (!reopened) {
        throw errors.conflict('OCO_GROUP_CLOSED', 'That bracket changed while being re-armed');
      }
    }
    const group =
      canonical ??
      reopened ??
      (await database.bracketGroup.create({
        data: {
          id: groupId,
          ...expected,
          protectedQuantity: dto.quantity,
        },
      }));
    if (group.protectedQuantity !== dto.quantity) {
      throw errors.conflict(
        'OCO_GROUP_QUANTITY_MISMATCH',
        'Target and stop quantities must match; resize the existing bracket first',
      );
    }
    return group.id;
  }

  private bracketScopeDiffers(
    group: Pick<
      BracketGroup,
      'provider' | 'environment' | 'accountId' | 'contractSymbol' | 'closeSide'
    >,
    expected: {
      provider: string;
      environment: string;
      accountId: string;
      contractSymbol: string;
      closeSide: string;
    },
  ): boolean {
    return (
      group.environment !== expected.environment ||
      group.provider !== expected.provider ||
      group.accountId !== expected.accountId ||
      group.contractSymbol !== expected.contractSymbol ||
      group.closeSide !== expected.closeSide
    );
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
