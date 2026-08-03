import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Prisma, type TradeOrder, type TradeOrderExecution } from '@prisma/client';
import { Subscription } from 'rxjs';
import { OrderResult, TradeHistory, TradeHistoryEntry } from '@0dtetrader/shared-types';
import { OPTION_MULTIPLIER } from '../broker/contract-resolution';
import { OrderEventsService } from '../broker/order-events.service';
import { PrismaService } from '../prisma/prisma.service';

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Running average-cost state for one contract, rebuilt by replaying fills. */
interface BookEntry {
  quantity: number;
  avgPrice: number;
  /** Quantity-weighted price of the UNDERLYING behind the open quantity. */
  avgUnderlying: number;
  /** Quantity that contributed to avgUnderlying — orders placed before the
   *  underlying price was recorded contribute none, and must not be averaged
   *  in as zero. */
  underlyingQty: number;
  /** When the fill that opened the current position run happened (the fill
   *  where quantity last left zero). Execution time (`filledAt`); legacy rows
   *  recorded before fill timestamps fall back to placement time. */
  openedAt: Date | null;
}

/** What positionAnchors reports per open contract, for annotating Positions. */
export interface PositionAnchor {
  /** The replayed book's SIGNED quantity. The caller must reconcile it with
   *  the broker's before trusting the anchor: app-side history can miss
   *  fills (outside orders, missed polls), and an entry price averaged over
   *  the wrong fills is worse than none — "Move stop to entry" consumes it. */
  quantity: number;
  underlyingEntryPrice?: number;
  openedAt?: Date;
}

/** One execution — a real recorded increment, or one synthesized from a
 *  row's cumulative state where increments were never recorded — in the
 *  order the MARKET produced them. `quantity` is positive; the sign comes
 *  from the row's side. */
interface FillEvent {
  time: Date;
  quantity: number;
  price: number;
  row: TradeOrder;
}

/**
 * Executed quantity: the broker-reported filled amount when present (a partial
 * fill at the full order quantity would overstate both the position book and
 * realized P/L).
 */
function fillQuantity(row: TradeOrder): number {
  return row.filledQuantity ?? row.quantity;
}

/**
 * A cancelled order with a recorded filled quantity executed that portion
 * before cancelling — it is a real fill for accounting purposes.
 *
 * The executed quantity must be strictly positive for EVERY status: a broker
 * snapshot reporting `filled` with an explicit `filledQuantity: 0` would
 * otherwise reach applyFill with size 0 and divide 0/0 — one NaN in a
 * contract's average cost poisons its realized P/L and entry-line anchor for
 * every fill after it.
 */
function isFill(row: TradeOrder): boolean {
  return (
    row.filledPrice !== null &&
    fillQuantity(row) > 0 &&
    (row.status === 'filled' ||
      row.status === 'partially_filled' ||
      (row.status === 'cancelled' && row.filledQuantity !== null))
  );
}

/** The isFill test for an incoming event, before it becomes a row. */
function isFillEvent(order: OrderResult): boolean {
  return (
    order.filledPrice !== undefined &&
    (order.filledQuantity ?? order.quantity) > 0 &&
    (order.status === 'filled' ||
      order.status === 'partially_filled' ||
      (order.status === 'cancelled' && order.filledQuantity !== undefined))
  );
}

/**
 * When a fill event executed: the broker's execution timestamp when the
 * gateway reports one, else the moment the fill was observed — the closest
 * verified time to execution. Never the order's placement time: a resting
 * limit can fill long after it was placed.
 */
function fillTimeOf(order: OrderResult): Date {
  const reported = order.filledAt ? new Date(order.filledAt) : null;
  return reported !== null && !Number.isNaN(reported.getTime()) ? reported : new Date();
}

/** The event's cumulative executed quantity (0 when it is not a fill). */
function cumulativeOf(order: OrderResult): number {
  return isFillEvent(order) ? (order.filledQuantity ?? order.quantity) : 0;
}

/**
 * The price of the increment between two cumulative snapshots. Brokers
 * report `filledPrice` as a cumulative AVERAGE (Alpaca's filled_avg_price
 * explicitly; SnapTrade's execution_price is ambiguously named), so the
 * increment is recovered from the moving average; when the arithmetic
 * degenerates (junk or missing inputs — upstream mappers already guard
 * finiteness), the reported price is the honest fallback.
 */
function incrementPrice(
  oldAvg: number | null,
  cumBefore: number,
  newAvg: number | undefined,
  cumAfter: number,
  delta: number,
): number {
  if (typeof newAvg !== 'number' || !Number.isFinite(newAvg)) return oldAvg ?? 0;
  if (cumBefore > 0 && typeof oldAvg === 'number' && Number.isFinite(oldAvg)) {
    const derived = (cumAfter * newAvg - cumBefore * oldAvg) / delta;
    if (Number.isFinite(derived) && derived > 0) return derived;
  }
  return newAvg;
}

/**
 * Turns rows plus their recorded executions into fill events in MARKET
 * order. Recorded increments are the ground truth; a fill row whose
 * increments do not cover its cumulative quantity (recorded before the
 * executions table, or whose earliest fills predate it) synthesizes one
 * event for the uncovered remainder at the row's first-fill time, priced at
 * the cumulative average — the closest persisted truth for fills whose
 * individual moments were never kept.
 */
function fillEventsFor(rows: TradeOrder[], executions: TradeOrderExecution[]): FillEvent[] {
  const byOrder = new Map<string, TradeOrderExecution[]>();
  for (const execution of executions) {
    const list = byOrder.get(execution.orderId);
    if (list) list.push(execution);
    else byOrder.set(execution.orderId, [execution]);
  }
  const events: FillEvent[] = [];
  for (const row of rows) {
    const recorded = (byOrder.get(row.id) ?? [])
      .slice()
      .sort(
        (a, b) =>
          a.executedAt.getTime() - b.executedAt.getTime() ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      );
    let covered = 0;
    for (const execution of recorded) {
      if (!(execution.quantity > 0) || !Number.isFinite(execution.price)) continue;
      covered += execution.quantity;
      events.push({
        time: execution.executedAt,
        quantity: execution.quantity,
        price: execution.price,
        row,
      });
    }
    if (isFill(row)) {
      const remainder = fillQuantity(row) - covered;
      if (remainder > 0) {
        events.push({
          time: row.filledAt ?? row.placedAt,
          quantity: remainder,
          price: row.filledPrice as number,
          row,
        });
      }
    }
  }
  // Market order, not placement order: a resting limit fills long after
  // later-placed orders do. Ties break deterministically so the replay is
  // stable across runs.
  events.sort(
    (a, b) =>
      a.time.getTime() - b.time.getTime() ||
      a.row.placedAt.getTime() - b.row.placedAt.getTime() ||
      a.row.id.localeCompare(b.row.id),
  );
  return events;
}

/**
 * Applies one execution to the running average-cost book, returning the
 * realized P/L it produced (null for opening or adding executions).
 *
 * Shared by the trade history and the chart's entry-line anchors so both read
 * the same position out of the same executions.
 *
 * `key` is the caller's choice of what counts as one position. It must never
 * merge environments: a practice buy and a live sell of the same contract are
 * two unrelated positions, and averaging them would realize the live sale
 * against a cost basis the account never paid.
 */
function applyExecution(
  book: Map<string, BookEntry>,
  key: string,
  event: FillEvent,
): number | null {
  const { row } = event;
  const position = book.get(key) ?? {
    quantity: 0,
    avgPrice: 0,
    avgUnderlying: 0,
    underlyingQty: 0,
    openedAt: null,
  };
  const signed = row.side === 'buy' ? event.quantity : -event.quantity;
  const size = Math.abs(signed);
  const price = event.price;
  // Rows predating the column (and any source reporting a junk price) must be
  // skipped rather than averaged in as zero, which would drag the anchor to a
  // level the position was never opened at.
  const underlying =
    typeof row.underlyingPrice === 'number' && Number.isFinite(row.underlyingPrice)
      ? row.underlyingPrice
      : null;
  let realized: number | null = null;

  if (position.quantity === 0 || Math.sign(position.quantity) === Math.sign(signed)) {
    // Opening or adding: blend the average cost. The opening time is this
    // execution's — for a synthesized legacy event, the row's first-fill
    // time (or placement, the closest persisted moment before that column).
    if (position.quantity === 0) position.openedAt = event.time;
    const totalQty = Math.abs(position.quantity) + size;
    position.avgPrice = (position.avgPrice * Math.abs(position.quantity) + price * size) / totalQty;
    if (underlying !== null) {
      const underlyingTotal = position.underlyingQty + size;
      position.avgUnderlying =
        (position.avgUnderlying * position.underlyingQty + underlying * size) / underlyingTotal;
      position.underlyingQty = underlyingTotal;
    }
    position.quantity += signed;
  } else {
    // Reducing (or flipping through zero): realize on the closed quantity.
    const closed = Math.min(size, Math.abs(position.quantity));
    const direction = Math.sign(position.quantity);
    realized = round2((price - position.avgPrice) * closed * direction * OPTION_MULTIPLIER);
    position.quantity += signed;
    if (position.quantity === 0) {
      position.avgPrice = 0;
      position.avgUnderlying = 0;
      position.underlyingQty = 0;
      position.openedAt = null;
    } else if (Math.sign(position.quantity) !== direction) {
      // Flipped: the remainder is a new position anchored on this execution.
      position.avgPrice = price;
      position.avgUnderlying = underlying ?? 0;
      position.underlyingQty = underlying === null ? 0 : Math.abs(position.quantity);
      position.openedAt = event.time;
    } else {
      // Partially closed: the average is unchanged, but it now backs less size.
      position.underlyingQty = Math.min(position.underlyingQty, Math.abs(position.quantity));
    }
  }
  book.set(key, position);
  return realized;
}

/**
 * Persists every order (and its async status updates — fills, cancels,
 * rejections — off the order-events bus) and serves the trade history with
 * realized P/L per closing fill, computed by the average-cost method.
 */
@Injectable()
export class OrdersService implements OnModuleDestroy {
  private readonly logger = new Logger(OrdersService.name);
  private readonly eventsSub: Subscription;

  constructor(
    private readonly prisma: PrismaService,
    orderEvents: OrderEventsService,
  ) {
    this.eventsSub = orderEvents.events$.subscribe((event) => {
      void this.record(event.userId, event.order).catch((err) =>
        this.logger.warn(`failed to persist order update: ${(err as Error).message}`),
      );
    });
  }

  onModuleDestroy(): void {
    this.eventsSub.unsubscribe();
  }

  /** The full row for an order seen for the first time. */
  private async createData(
    userId: string,
    order: OrderResult,
    underlyingPrice?: number,
  ): Promise<Prisma.TradeOrderUncheckedCreateInput> {
    const placedAt = new Date(order.timestamp);
    // Stamp the environment (live/practice) in effect when the order is first
    // recorded; later status updates never move an order across environments.
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return {
      id: order.orderId,
      userId,
      contractSymbol: order.contractSymbol,
      assetClass: 'option',
      environment: user?.tradingMode === 'practice' ? 'practice' : 'live',
      side: order.side,
      quantity: order.quantity,
      filledQuantity: order.filledQuantity ?? null,
      orderType: order.orderType,
      limitPrice: order.limitPrice ?? null,
      filledPrice: order.filledPrice ?? null,
      filledAt: isFillEvent(order) ? fillTimeOf(order) : null,
      underlyingPrice: underlyingPrice ?? null,
      status: order.status,
      placedAt: Number.isNaN(placedAt.getTime()) ? new Date() : placedAt,
    };
  }

  /**
   * One serial chain per order. Two events for the same order arrive
   * concurrently in practice — a placement emit racing its webhook,
   * duplicate webhook redeliveries, poller ticks — and recording is a
   * read-modify-write (the execution delta is computed against the stored
   * row). In-process serialization is sufficient by design: order events
   * ride this instance's in-process buses (the polling instance owns them),
   * and the repo deliberately uses no database transactions (see
   * PrismaService's doc comment and the test fake's delegate surface).
   */
  private readonly recordChains = new Map<string, Promise<void>>();

  private enqueueForOrder(orderId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.recordChains.get(orderId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    const tail = run.catch(() => undefined);
    this.recordChains.set(orderId, tail);
    void tail.finally(() => {
      if (this.recordChains.get(orderId) === tail) this.recordChains.delete(orderId);
    });
    return run;
  }

  /** Upsert an order row; updates only fields a status change can move. */
  async record(userId: string, order: OrderResult): Promise<void> {
    return this.enqueueForOrder(order.orderId, () => this.recordSerialized(userId, order));
  }

  private async recordSerialized(userId: string, order: OrderResult): Promise<void> {
    const existing = await this.prisma.tradeOrder.findUnique({ where: { id: order.orderId } });
    // Fill state only ever ADVANCES: cumulative filled quantity is monotone
    // at the broker, so an event carrying less than the stored row is stale
    // (out-of-order delivery, a redelivered webhook) and must not regress
    // the row — the previous last-writer-wins update could. Status stays
    // last-writer-wins; fill ordering is what the replay depends on.
    // Everything the increment derivation needs is read BEFORE any write —
    // the row object must be treated as invalid once updated.
    const cumBefore = existing && isFill(existing) ? fillQuantity(existing) : 0;
    const oldAvgPrice = existing?.filledPrice ?? null;
    const cumAfter = Math.max(cumulativeOf(order), cumBefore);
    const advances = cumAfter > cumBefore;

    if (existing) {
      await this.prisma.tradeOrder.updateMany({
        where: { id: order.orderId },
        data: {
          status: order.status,
          ...(advances && {
            filledPrice: order.filledPrice ?? null,
            filledQuantity: order.filledQuantity ?? null,
          }),
        },
      });
    } else {
      await this.prisma.tradeOrder.upsert({
        where: { id: order.orderId },
        create: await this.createData(userId, order),
        update: {},
      });
    }

    if (!isFillEvent(order)) return;
    // First fill wins: openedAt anchors on the execution that made the
    // position quantity nonzero, so a later fill event (or a re-poll of the
    // same fill) must never move an existing timestamp.
    await this.prisma.tradeOrder.updateMany({
      where: { id: order.orderId, filledAt: null },
      data: { filledAt: fillTimeOf(order) },
    });
    if (!advances) return;
    // The increment this event revealed, kept as its own row: the order row
    // holds only cumulative state, and interleaved partial fills across
    // orders can only be replayed in market order from the increments.
    const delta = cumAfter - cumBefore;
    await this.prisma.tradeOrderExecution.create({
      data: {
        orderId: order.orderId,
        quantity: delta,
        price: incrementPrice(oldAvgPrice, cumBefore, order.filledPrice, cumAfter, delta),
        executedAt: fillTimeOf(order),
      },
    });
  }

  /**
   * Stamps the underlying price on an order the placement path just sent.
   *
   * Deliberately narrow: on an existing row this touches *only* that column.
   * Re-recording the whole order here would race the broker's status poll —
   * which is already running by the time the placement path gets control — and
   * could roll a fill back to `submitted` with a null fill price, corrupting
   * both the trade history and realized P/L.
   */
  async recordUnderlyingPrice(
    userId: string,
    order: OrderResult,
    underlyingPrice: number,
  ): Promise<void> {
    // Same per-order chain as record(): the placement path and the events
    // bus write the same row, and only ordering keeps the create race out.
    return this.enqueueForOrder(order.orderId, () =>
      this.recordUnderlyingPriceSerialized(userId, order, underlyingPrice),
    );
  }

  private async recordUnderlyingPriceSerialized(
    userId: string,
    order: OrderResult,
    underlyingPrice: number,
  ): Promise<void> {
    try {
      await this.prisma.tradeOrder.upsert({
        where: { id: order.orderId },
        create: await this.createData(userId, order, underlyingPrice),
        update: { underlyingPrice },
      });
      return;
    } catch (err) {
      // The events bus won the race to create this row between the upsert's own
      // read and its insert. The row exists now, so the narrow update the upsert
      // *would* have taken is still the right write — retry it rather than
      // losing the anchor and drawing the entry line at the wrong level.
      const { count } = await this.prisma.tradeOrder.updateMany({
        where: { id: order.orderId },
        data: { underlyingPrice },
      });
      if (count > 0) return;
      // Genuinely could not record it. Never fail the order over an entry line,
      // but say so — a silently missing anchor looks like a client bug.
      this.logger.warn(
        `failed to record underlying price for ${order.orderId}: ${(err as Error).message}`,
      );
    }
  }

  /** The recorded executions behind a set of rows (one query; joined in JS —
   *  the replay needs them grouped and sorted its own way regardless). */
  private async executionsFor(rows: TradeOrder[]): Promise<TradeOrderExecution[]> {
    if (rows.length === 0) return [];
    return this.prisma.tradeOrderExecution.findMany({
      where: { orderId: { in: rows.map((row) => row.id) } },
    });
  }

  /**
   * Quantity-weighted underlying price behind each of the given open contracts
   * — the level the chart draws a position's entry line at.
   *
   * Scoped to the contracts the broker actually reports open (and to the user's
   * current environment), so this replays a handful of fills rather than the
   * user's whole order history. Contracts with no recorded underlying price
   * (opened before the column existed, or outside the app) carry no price —
   * the clients simply omit the entry line — but still report openedAt when
   * their fills are on record. Every anchor carries the replayed signed
   * quantity so the caller can refuse anchors whose replay does not account
   * for the whole broker position.
   */
  async positionAnchors(
    userId: string,
    contractSymbols: string[],
  ): Promise<Map<string, PositionAnchor>> {
    if (contractSymbols.length === 0) return new Map();
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const environment = user?.tradingMode === 'practice' ? 'practice' : 'live';
    const rows = await this.prisma.tradeOrder.findMany({
      where: { userId, environment, contractSymbol: { in: contractSymbols } },
      orderBy: { placedAt: 'asc' },
    });

    const book = new Map<string, BookEntry>();
    for (const event of fillEventsFor(rows, await this.executionsFor(rows))) {
      // Already narrowed to one environment, so the symbol alone is the position.
      applyExecution(book, event.row.contractSymbol, event);
    }

    const anchors = new Map<string, PositionAnchor>();
    for (const [symbol, entry] of book) {
      if (entry.quantity === 0) continue;
      const anchor: PositionAnchor = { quantity: entry.quantity };
      if (entry.underlyingQty > 0) anchor.underlyingEntryPrice = round2(entry.avgUnderlying);
      if (entry.openedAt) anchor.openedAt = entry.openedAt;
      if (anchor.underlyingEntryPrice !== undefined || anchor.openedAt) {
        anchors.set(symbol, anchor);
      }
    }
    return anchors;
  }

  async history(userId: string): Promise<TradeHistory> {
    const rows = await this.prisma.tradeOrder.findMany({
      where: { userId },
      orderBy: { placedAt: 'asc' },
    });

    // Average-cost realized P/L, replayed in MARKET order across every
    // execution (a resting limit fills long after later-placed orders).
    // History spans both environments, so the book is keyed by environment
    // as well as symbol — otherwise a practice buy would become the cost
    // basis for a live sale of the same contract. The list itself stays one
    // entry per ORDER; an order's realized P/L is the sum over its closing
    // executions.
    const book = new Map<string, BookEntry>();
    const realizedByOrder = new Map<string, number>();
    let total = 0;
    for (const event of fillEventsFor(rows, await this.executionsFor(rows))) {
      const { row } = event;
      const realized = applyExecution(book, `${row.environment}|${row.contractSymbol}`, event);
      if (realized !== null) {
        realizedByOrder.set(row.id, (realizedByOrder.get(row.id) ?? 0) + realized);
        total += realized;
      }
    }

    const entries: TradeHistoryEntry[] = rows.map((row) => {
      const realized = realizedByOrder.get(row.id);
      return {
        orderId: row.id,
        status: row.status as TradeHistoryEntry['status'],
        contractSymbol: row.contractSymbol,
        side: row.side as TradeHistoryEntry['side'],
        quantity: row.quantity,
        orderType: row.orderType as TradeHistoryEntry['orderType'],
        limitPrice: row.limitPrice ?? undefined,
        filledPrice: row.filledPrice ?? undefined,
        timestamp: row.placedAt.toISOString(),
        realizedPnl: realized !== undefined ? round2(realized) : null,
      };
    });

    return { entries: entries.reverse(), totalRealizedPnl: round2(total) };
  }
}
