import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Prisma, type TradeOrder, type TradeOrderExecution } from '@prisma/client';
import {
  OrderResult,
  TradeHistory,
  TradeHistoryEntry,
  TradingMode,
} from '@0dtetrader/shared-types';
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
    // Strictly positive, like the quantity below: a zero or negative price
    // is refused at the door rather than advancing the watermark and then
    // being filtered out of every replay.
    isFinitePositive(order.filledPrice) &&
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

/** One point on an order's cumulative fill curve: how much had executed, at
 *  what cumulative average price, and when the execution was observed. */
interface FillPoint {
  cumulative: number;
  avgPrice: number;
  time: Date;
}

/** Prices and quantities are strictly positive in this domain: a zero or
 *  negative one is junk that would poison an average-cost book, so it is
 *  refused rather than booked. */
const isFinitePositive = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0;

/** How late a fill may be, relative to placement, and still be anchored on the
 *  underlying price captured when the order was sent. A market or marketable
 *  limit fills inside this; a resting limit that fills minutes later did so at
 *  an underlying level nobody recorded. */
const FILL_ANCHOR_MAX_LAG_MS = 60_000;

/**
 * Reconstructs one order's cumulative fill curve from its recorded rows,
 * whatever shape they were written in.
 *
 * A snapshot row states the curve directly. The two older shapes state an
 * INCREMENT, so their point is the running prefix: the cumulative they
 * carry (or the running sum, for rows predating that column) at the average
 * their notional implies. Points are ordered by CUMULATIVE — the only
 * reliable sequence key, since an out-of-order observation can carry an
 * earlier cumulative than one already recorded.
 */
function fillCurveFor(executions: TradeOrderExecution[]): FillPoint[] {
  const byArrival = executions
    .slice()
    .sort(
      (a, b) =>
        a.executedAt.getTime() - b.executedAt.getTime() ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
  // Rows with no cumulative column are increments in arrival order; imply
  // theirs from the running sum before anything is sequenced by cumulative.
  const implied = new Map<string, number>();
  let running = 0;
  for (const row of byArrival) {
    if (row.cumulative !== null) continue;
    if (!isFinitePositive(row.quantity) || row.quantity <= 0) continue;
    running += row.quantity;
    implied.set(row.id, running);
  }

  const seen = new Set<number>();
  const ordered = byArrival
    .map((row) => ({ row, cumulative: row.cumulative ?? implied.get(row.id) ?? null }))
    .filter((entry) => isFinitePositive(entry.cumulative) && entry.cumulative > 0)
    .sort(
      (a, b) =>
        (a.cumulative as number) - (b.cumulative as number) ||
        // A real snapshot outranks an increment row at the same cumulative:
        // both describe the same point, and only the snapshot states it.
        Number(a.row.avgPrice === null) - Number(b.row.avgPrice === null),
    );

  const points: FillPoint[] = [];
  let prevNotional = 0;
  for (const { row, cumulative } of ordered) {
    const cum = cumulative as number;
    if (seen.has(cum)) continue;
    // A snapshot's notional is stated; an increment's is the prefix it
    // extends — which is also how a row written with a cumulative but no
    // average (an instance that predates the column) is recovered.
    let notional: number | null = null;
    if (isFinitePositive(row.avgPrice)) notional = cum * row.avgPrice;
    else if (isFinitePositive(row.quantity) && isFinitePositive(row.price)) {
      notional = prevNotional + row.quantity * row.price;
    }
    if (notional === null || !Number.isFinite(notional)) continue;
    seen.add(cum);
    points.push({ cumulative: cum, avgPrice: notional / cum, time: row.executedAt });
    prevNotional = notional;
  }
  return points;
}

/**
 * Turns rows plus their recorded executions into fill events in MARKET
 * order.
 *
 * Each order's increments are the differences between consecutive points on
 * its cumulative fill curve, derived here rather than at write time — which
 * is what lets a late partial slot into place instead of being discarded.
 *
 * Events are clamped to the row's AUTHORITY: the quantity the row itself
 * vouches for (its executedQuantity watermark, or its cumulative fill state
 * for rows advanced before that column). The watermark is advanced before
 * any observation is recorded, so it never clamps a real one; what it does
 * clamp is duplicate increment rows left by the status-regression bug. A row
 * whose curve does not cover its authority (recorded before this table, or
 * an observation lost to an insert failure) synthesizes one event for the
 * uncovered remainder at the row's first-fill time, priced at the RESIDUAL
 * that makes the replayed book's average equal the broker's reported one.
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
    const authority = Math.max(row.executedQuantity ?? 0, isFill(row) ? fillQuantity(row) : 0);
    const points = fillCurveFor(byOrder.get(row.id) ?? []);
    const increments: { quantity: number; price: number; time: Date }[] = [];
    let prevCumulative = 0;
    let prevAvgPrice: number | null = null;
    for (const point of points) {
      const delta = point.cumulative - prevCumulative;
      if (delta <= 0) continue;
      increments.push({
        quantity: delta,
        price: incrementPrice(
          prevAvgPrice,
          prevCumulative,
          point.avgPrice,
          point.cumulative,
          delta,
        ),
        time: point.time,
      });
      prevCumulative = point.cumulative;
      prevAvgPrice = point.avgPrice;
    }
    // An observation time is an UPPER BOUND on execution, not the execution
    // itself: it is when the broker reported a cumulative, and every unit up
    // to that cumulative had already executed by then. So each increment is
    // placed at the earliest time any observation vouched for it — the
    // suffix minimum over the cumulative-ordered increments, which is
    // non-decreasing by construction, keeping an order's own fills in
    // sequence.
    //
    // This matters when a report arrives out of order and the broker stamps
    // no execution time of its own (Webull reports none, so an observation is
    // stamped on ARRIVAL): a terminal report of cumulative 3 proves all three
    // units executed by then, and a partial arriving later must not push two
    // of them past a close that happened in between. Where the broker does
    // report execution times (Alpaca, SnapTrade) they are already
    // non-decreasing in cumulative and this is the identity.
    const times: Date[] = new Array(increments.length);
    let bound: Date | null = null;
    for (let k = increments.length - 1; k >= 0; k -= 1) {
      const observed = increments[k].time;
      bound = bound === null || +observed < +bound ? observed : bound;
      times[k] = bound;
    }

    let covered = 0;
    let coveredNotional = 0;
    increments.forEach((increment, index) => {
      const take = Math.min(increment.quantity, authority - covered);
      if (take <= 0) return;
      events.push({ time: times[index], quantity: take, price: increment.price, row });
      covered += take;
      coveredNotional += take * increment.price;
    });

    const remainder = authority - covered;
    // The finite-price guard, not isFill: replay is decoupled from status, so
    // a fill whose status was later regressed by a stale event still replays.
    if (remainder > 0 && isFinitePositive(row.filledPrice)) {
      // What the uncovered quantity must have executed at for the book's
      // average to come out at the broker's cumulative average. With nothing
      // covered this is just that average, which is all a row recorded before
      // this table can say.
      const residual = (authority * row.filledPrice - coveredNotional) / remainder;
      events.push({
        time: row.filledAt ?? row.placedAt,
        quantity: remainder,
        price: Number.isFinite(residual) && residual > 0 ? residual : row.filledPrice,
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
  // The underlying price was captured when the order was SENT, so it anchors
  // the entry only for a fill that happened promptly. A resting limit that
  // filled minutes later did so at a level nobody recorded, and "Move stop to
  // entry" would then arm an unattended stop at a price the position never
  // opened at — better to report no anchor and let the button disable.
  // Rows predating the column (and any source reporting a junk price) are
  // skipped for the same reason: averaged in as zero they would drag the
  // anchor to a level the position was never opened at.
  const promptFill = event.time.getTime() - row.placedAt.getTime() <= FILL_ANCHOR_MAX_LAG_MS;
  const underlying =
    promptFill && typeof row.underlyingPrice === 'number' && Number.isFinite(row.underlyingPrice)
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
  private readonly unregisterIngestor: () => void;

  constructor(
    private readonly prisma: PrismaService,
    orderEvents: OrderEventsService,
  ) {
    // Registered as an INGESTOR, not a subscriber: the webhook path must be
    // able to await persistence before acknowledging the provider, and an
    // RxJS subscription cannot be awaited. Fire-and-forget emitters (polls,
    // placement) run the same function; its exhaustion throw is swallowed
    // there after the logging below has said its piece.
    this.unregisterIngestor = orderEvents.registerIngestor((event) =>
      this.recordWithRetry(event.userId, event.order, event.environment),
    );
  }

  /**
   * Persist an order update, retrying with bounded exponential backoff and
   * jitter, and THROWING once the attempts are exhausted — the webhook
   * caller turns that into a 5xx so the provider redelivers.
   *
   * record() writes in several statements — ensure-exists, the status
   * transition, the earliest-fill stamp, the watermark advance, the
   * observation — and a failure part-way leaves the earlier ones committed.
   * Every one of them is idempotent by construction (an upsert, three
   * predicate-guarded updates, and an insert under a unique index), so
   * replaying the whole call is safe and converges. That is what this repo
   * has instead of a transaction, which it deliberately does not use: a
   * rollback would be WORSE here, discarding a fill the broker already
   * reported rather than leaving a partial record the replay can still
   * account for and a later report can complete.
   *
   * The backoff exists because immediate retries all land inside the same
   * outage; it stays short because the webhook response is waiting on it.
   * What survives a process death is the provider redelivering.
   */
  private async recordWithRetry(
    userId: string,
    order: OrderResult,
    environment?: TradingMode,
  ): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.record(userId, order, environment);
        return;
      } catch (err) {
        if (attempt >= OrdersService.RECORD_ATTEMPTS) {
          this.logger.warn(
            `failed to persist order update for ${order.orderId} after ` +
              `${attempt} attempts: ${(err as Error).message}`,
          );
          throw err;
        }
        const delay =
          OrdersService.RETRY_BASE_MS * 2 ** (attempt - 1) +
          Math.random() * OrdersService.RETRY_JITTER_MS;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private static readonly RETRY_BASE_MS = 150;
  private static readonly RETRY_JITTER_MS = 100;

  private static readonly RECORD_ATTEMPTS = 3;

  onModuleDestroy(): void {
    this.unregisterIngestor();
  }

  /** The full row for an order seen for the first time. */
  private async createData(
    userId: string,
    order: OrderResult,
    underlyingPrice?: number,
    /** The environment the emitter VERIFIED this order belongs to (a webhook
     *  knows it from the credential the event was signed with). */
    knownEnvironment?: TradingMode,
  ): Promise<Prisma.TradeOrderUncheckedCreateInput> {
    const placedAt = new Date(order.timestamp);
    // Stamp the environment (live/practice) the order was placed in; later
    // status updates never move an order across environments. The user's
    // current mode is only a fallback — it is mutable, so a fill arriving
    // after a switch would otherwise be filed under the wrong account.
    const user = knownEnvironment
      ? null
      : await this.prisma.user.findUnique({ where: { id: userId } });
    return {
      id: order.orderId,
      userId,
      contractSymbol: order.contractSymbol,
      assetClass: 'option',
      environment: knownEnvironment ?? (user?.tradingMode === 'practice' ? 'practice' : 'live'),
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
   * compare-and-set watermark advance in recordFillProgress — none of which
   * needs a transaction (the repo deliberately uses none; see
   * PrismaService's doc comment). The chain merely keeps one instance from
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
  async record(userId: string, order: OrderResult, environment?: TradingMode): Promise<void> {
    // An order with no broker id has no identity to persist under. `id` is
    // this table's primary key, so every id-less event — from any user —
    // would land on one shared row, and a later fill would mutate whichever
    // order got there first. Emitters are expected to drop these; this is
    // the backstop for the ones that do not.
    if (!order.orderId) return;
    return this.enqueueForOrder(order.orderId, () =>
      this.recordSerialized(userId, order, environment),
    );
  }

  private async recordSerialized(
    userId: string,
    order: OrderResult,
    environment?: TradingMode,
  ): Promise<void> {
    // Ensure the row exists (native ON CONFLICT under the hood: atomic across
    // instances). Fill fields are deliberately absent from THIS create: they
    // move only in the same statement as the executedQuantity watermark
    // below, so no reader can ever see fill state the watermark doesn't
    // cover. filledAt is dropped with them — the first-fill write below
    // stamps it with the same fillTimeOf in the same call.
    const base = await this.createData(userId, order, undefined, environment);
    const row = await this.prisma.tradeOrder.upsert({
      where: { id: order.orderId },
      create: { ...base, filledQuantity: null, filledPrice: null, filledAt: null },
      update: {},
    });
    // The primary key is the BROKER's order id, unique only within a
    // brokerage account. If the id already belongs to a different user, this
    // event is a collision, and processing it would let one user's fill
    // write executions and fill state into another user's order. Every write
    // below is additionally {id, userId}-scoped as a belt, but the execution
    // insert keys on orderId alone — so nothing at all may proceed until
    // ownership is positively established.
    if (row.userId !== userId) {
      this.logger.warn(
        `broker order id collision: ${order.orderId} belongs to another user; ` +
          `dropping event for user ${userId} (status ${order.status})`,
      );
      return;
    }

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
        where: { id: order.orderId, userId, status: { in: ['submitted', 'partially_filled'] } },
        data: { status: order.status },
      });
    } else if (order.status === 'filled') {
      await this.prisma.tradeOrder.updateMany({
        where: {
          id: order.orderId,
          userId,
          status: { in: ['submitted', 'partially_filled', 'cancelled', 'rejected'] },
        },
        data: { status: 'filled' },
      });
    }

    if (!isFillEvent(order)) return;
    const executedAt = fillTimeOf(order);
    // openedAt anchors on the order's EARLIEST execution, so this write moves
    // the stamp backwards but never forwards: a re-poll of the same fill, or
    // a later fill event, must not move it, while a partial that arrives
    // after the fill it preceded must correct it.
    await this.prisma.tradeOrder.updateMany({
      where: {
        id: order.orderId,
        userId,
        OR: [{ filledAt: null }, { filledAt: { gt: executedAt } }],
      },
      data: { filledAt: executedAt },
    });
    await this.recordFillProgress(userId, order, executedAt);
  }

  /**
   * Advances the order's cumulative fill state and records the observation
   * behind it.
   *
   * Two independent writes, deliberately not a pair:
   *
   * `executedQuantity` is the monotone watermark — the quantity the row
   * vouches for. It is independent of status (a stale status regression must
   * not cause a double-record) and advances in ONE guarded statement, which
   * is all the atomicity it needs: under READ COMMITTED, Postgres
   * re-evaluates the predicate against the updated row after a concurrent
   * writer commits, so a recorder on another instance carrying a lower
   * cumulative simply matches nothing. (The in-memory test double cannot
   * model that re-check — it is single-threaded — so the concurrency tests
   * pin the outcome, not the mechanism.)
   *
   * The observation is then recorded UNCONDITIONALLY, even when its
   * cumulative sits below the watermark. That is the whole point: a
   * cumulative below the watermark is either a late partial the replay needs
   * in order to place the earlier fill (its price and its moment are
   * recoverable from nowhere else), or a redelivery repairing an
   * observation whose insert failed. Gating this on the watermark is what
   * made both of those unrecoverable.
   */
  private async recordFillProgress(
    userId: string,
    order: OrderResult,
    executedAt: Date,
  ): Promise<void> {
    const cumulative = cumulativeOf(order);
    if (!(cumulative > 0)) return;
    await this.prisma.tradeOrder.updateMany({
      where: { id: order.orderId, userId, executedQuantity: { lt: cumulative } },
      data: {
        executedQuantity: cumulative,
        filledQuantity: order.filledQuantity ?? null,
        filledPrice: order.filledPrice ?? null,
      },
    });
    // A resting order re-reports the same cumulative on every poll tick, so
    // check before writing rather than letting the unique index reject tick
    // after tick. The index stays the authority — two instances can both miss
    // here — this only keeps the common case off the write path.
    const known = await this.prisma.tradeOrderExecution.findMany({
      where: { orderId: order.orderId, cumulative },
    });
    if (known.length > 0) return;
    try {
      await this.prisma.tradeOrderExecution.create({
        data: {
          orderId: order.orderId,
          cumulative,
          avgPrice: order.filledPrice ?? null,
          executedAt,
        },
      });
    } catch (err) {
      // P2002 on (orderId, cumulative): another recorder got there first —
      // exactly the outcome wanted. Anything else leaves the observation
      // unrecorded until a redelivery repairs it; the watermark has already
      // advanced, so the replay still books the quantity, priced at the
      // residual that keeps the book's average honest.
      if ((err as { code?: string }).code !== 'P2002') throw err;
    }
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
      // Ensure-exists first, with NO update: the upsert's where is the id
      // alone, and the id is only unique within a brokerage account. An
      // unconditional update here once let one user's placement overwrite
      // another user's entry anchor on a colliding id. Ownership is checked
      // on the returned row, and only an owned row takes the scoped write.
      const row = await this.prisma.tradeOrder.upsert({
        where: { id: order.orderId },
        create: await this.createData(userId, order, underlyingPrice),
        update: {},
      });
      if (row.userId !== userId) {
        this.logger.warn(
          `broker order id collision: ${order.orderId} belongs to another user; ` +
            `dropping underlying price from user ${userId}`,
        );
        return;
      }
      await this.prisma.tradeOrder.updateMany({
        where: { id: order.orderId, userId },
        data: { underlyingPrice },
      });
      return;
    } catch (err) {
      // The events bus won the race to create this row between the upsert's own
      // read and its insert. The row exists now, so the narrow, owner-scoped
      // update is still the right write — retry it rather than losing the
      // anchor and drawing the entry line at the wrong level.
      const { count } = await this.prisma.tradeOrder.updateMany({
        where: { id: order.orderId, userId },
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
