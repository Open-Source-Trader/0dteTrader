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
  cumulative: number;
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
 * order, clamped to each row's AUTHORITY — the quantity the row itself
 * vouches for: the executedQuantity watermark, or the cumulative fill state
 * for rows advanced before the watermark existed. The clamp is what keeps
 * historical duplicate increments (recorded before the watermark, when a
 * stale status regression could double-record) from replaying forever; in
 * steady state it is a no-op. A row whose recorded increments do not cover
 * its authority (recorded before the executions table, or an increment lost
 * to an insert failure) synthesizes one event for the uncovered remainder at
 * the row's first-fill time, priced at the cumulative average — the closest
 * persisted truth for fills whose individual moments were never kept.
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
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      );
    const authority = Math.max(row.executedQuantity ?? 0, isFill(row) ? fillQuantity(row) : 0);
    let covered = 0;
    for (const execution of recorded) {
      if (!(execution.quantity > 0) || !Number.isFinite(execution.price)) continue;
      const take = Math.min(execution.quantity, authority - covered);
      if (take <= 0) continue;
      events.push({
        time: execution.executedAt,
        quantity: take,
        price: execution.price,
        cumulative: execution.cumulative ?? covered + take,
        row,
      });
      covered += take;
    }
    const remainder = authority - covered;
    // The finite-price guard, not isFill: replay is decoupled from status, so
    // a fill whose status was later regressed by a stale event still replays.
    if (remainder > 0 && typeof row.filledPrice === 'number' && Number.isFinite(row.filledPrice)) {
      events.push({
        time: row.filledAt ?? row.placedAt,
        quantity: remainder,
        price: row.filledPrice,
        cumulative: authority,
        row,
      });
    }
  }
  // Market order, not placement order: a resting limit fills long after
  // later-placed orders do. Ties break deterministically so the replay is
  // stable across runs.
  events.sort(
    (a, b) =>
      a.time.getTime() - b.time.getTime() ||
      a.row.placedAt.getTime() - b.row.placedAt.getTime() ||
      a.row.id.localeCompare(b.row.id) ||
      a.cumulative - b.cumulative,
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
      // Explicit, not left to the schema default: the test fake applies no
      // schema defaults, and the replay arithmetic needs a number here.
      executedQuantity: 0,
      underlyingPrice: underlyingPrice ?? null,
      status: order.status,
      placedAt: Number.isNaN(placedAt.getTime()) ? new Date() : placedAt,
    };
  }

  /**
   * One serial chain per order — a CONTENTION optimization, not a
   * correctness mechanism. Two events for the same order arrive concurrently
   * in practice (a placement emit racing its webhook, duplicate
   * redeliveries, poller ticks), and OTHER API instances see the same order:
   * a webhook lands on whichever instance receives it while the poller runs
   * on the placing one. Correctness therefore lives in the database — the
   * ensure-exists upsert, the guarded status writes, and the
   * compare-and-set watermark advance and transactional execution write in
   * recordFillProgress. The chain merely keeps one instance from
   * burning CAS retries against itself.
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
    // Ensure the row exists (native ON CONFLICT under the hood: atomic across
    // instances). Fill fields are deliberately absent from THIS create: they
    // move only in the same statement as the executedQuantity watermark
    // below, so no reader can ever see fill state the watermark doesn't
    // cover. filledAt is dropped with them — the first-fill write below
    // stamps it with the same fillTimeOf in the same call.
    const base = await this.createData(userId, order);
    await this.prisma.tradeOrder.upsert({
      where: { id: order.orderId },
      create: { ...base, filledQuantity: null, filledPrice: null, filledAt: null },
      update: {},
    });

    // Status only moves FORWARD, each transition a predicate-guarded write so
    // concurrent recorders on other instances cannot interleave a regression:
    //   - `submitted` is create-only. It is every mapper's unknown-status
    //     fallback, and a stale one must never walk back a fill.
    //   - Between the terminals `cancelled` and `rejected`, first wins.
    //   - `filled` overrides even those: every gateway synthesizes
    //     `cancelled` on the cancel REQUEST before broker truth arrives, and
    //     no broker un-fills an order.
    if (
      order.status === 'partially_filled' ||
      order.status === 'cancelled' ||
      order.status === 'rejected'
    ) {
      await this.prisma.tradeOrder.updateMany({
        where: { id: order.orderId, status: { in: ['submitted', 'partially_filled'] } },
        data: { status: order.status },
      });
    } else if (order.status === 'filled') {
      await this.prisma.tradeOrder.updateMany({
        where: {
          id: order.orderId,
          status: { in: ['submitted', 'partially_filled', 'cancelled', 'rejected'] },
        },
        data: { status: 'filled' },
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
    await this.recordFillProgress(order);
  }

  /** Bounded compare-and-set attempts per fill event. Exhaustion drops the
   *  advance, which is safe: brokers redeliver fill state (webhook retries,
   *  poller ticks), and until then the replay synthesizes the uncovered
   *  remainder from whatever the watermark did record. */
  private static readonly CAS_ATTEMPTS = 5;

  /**
   * Advances the fill watermark and records the increment it claims.
   *
   * `executedQuantity` is the only authority on how much of the order's
   * cumulative fill has been recorded. It is independent of status (a stale
   * status regression must not cause a double-record) and advances by
   * compare-and-set, so recorders on different API instances each claim a
   * disjoint increment or lose the race and re-read. Fill fields ride the
   * same statement, which fences the reads below: filledPrice cannot change
   * between the read and a successful CAS. After any advance,
   * executedQuantity === filledQuantity ?? quantity for the claiming event.
   * The (orderId, cumulative) unique index is the belt to this suspender: an
   * ambiguous retry that re-claims a snapshot cannot insert it twice.
   */
  private async recordFillProgress(order: OrderResult): Promise<void> {
    const cumulative = cumulativeOf(order);
    for (let attempt = 0; attempt < OrdersService.CAS_ATTEMPTS; attempt += 1) {
      const result = await this.prisma.$transaction(async (tx) => {
        const row = await tx.tradeOrder.findUnique({ where: { id: order.orderId } });
        if (!row) return 'done' as const;
        const cumBefore = row.executedQuantity ?? 0;
        const oldAvgPrice = row.filledPrice ?? null;
        if (cumulative > cumBefore) {
          const { count } = await tx.tradeOrder.updateMany({
            where: { id: order.orderId, executedQuantity: cumBefore },
            data: {
              executedQuantity: cumulative,
              filledQuantity: order.filledQuantity ?? null,
              filledPrice: order.filledPrice ?? null,
            },
          });
          if (count === 0) return 'retry' as const;
          const delta = cumulative - cumBefore;
          try {
            await tx.tradeOrderExecution.create({
              data: {
                orderId: order.orderId,
                quantity: delta,
                price: incrementPrice(oldAvgPrice, cumBefore, order.filledPrice, cumulative, delta),
                cumulative,
                executedAt: fillTimeOf(order),
              },
            });
          } catch (err) {
            if ((err as { code?: string }).code !== 'P2002') throw err;
          }
          return 'done' as const;
        }

        // A lower cumulative snapshot can be delayed behind a later one. Keep
        // it rather than discarding it: split the next recorded increment so
        // the market-time replay can place it before an interleaved close.
        const executions = await tx.tradeOrderExecution.findMany({
          where: { orderId: order.orderId },
        });
        if (executions.some((execution) => execution.cumulative === cumulative)) {
          return 'done' as const;
        }
        const successor = executions
          .filter((execution) => execution.cumulative !== null && execution.cumulative > cumulative)
          .sort((a, b) => (a.cumulative as number) - (b.cumulative as number))[0];
        if (!successor || typeof order.filledPrice !== 'number') return 'done' as const;
        const preceding = executions
          .filter((execution) => execution.cumulative !== null && execution.cumulative < cumulative)
          .sort((a, b) => (b.cumulative as number) - (a.cumulative as number))[0];
        const priorCumulative = preceding?.cumulative ?? 0;
        const priorValue = executions
          .filter((execution) => (execution.cumulative ?? 0) <= priorCumulative)
          .reduce((total, execution) => total + execution.quantity * execution.price, 0);
        const lateQuantity = cumulative - priorCumulative;
        const successorQuantity = (successor.cumulative as number) - cumulative;
        if (!(lateQuantity > 0) || !(successorQuantity > 0)) return 'done' as const;
        const successorValue = priorValue + successor.quantity * successor.price;
        await tx.tradeOrderExecution.create({
          data: {
            orderId: order.orderId,
            quantity: lateQuantity,
            price: (cumulative * order.filledPrice - priorValue) / lateQuantity,
            cumulative,
            executedAt: fillTimeOf(order),
          },
        });
        await tx.tradeOrderExecution.update({
          where: { id: successor.id },
          data: {
            quantity: successorQuantity,
            price: (successorValue - cumulative * order.filledPrice) / successorQuantity,
          },
        });
        return 'done' as const;
      });
      if (result === 'done') return;
    }
    this.logger.warn(
      `execution watermark for ${order.orderId} still contended after ` +
        `${OrdersService.CAS_ATTEMPTS} attempts; dropping (broker redelivery heals)`,
    );
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
