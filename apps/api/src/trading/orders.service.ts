import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Prisma, type TradeOrder } from '@prisma/client';
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

/**
 * Applies one fill to the running average-cost book, returning the realized
 * P/L it produced (null for opening or adding fills).
 *
 * Shared by the trade history and the chart's entry-line anchors so both read
 * the same position out of the same fills.
 */
function applyFill(book: Map<string, BookEntry>, row: TradeOrder): number | null {
  const position = book.get(row.contractSymbol) ?? {
    quantity: 0,
    avgPrice: 0,
    avgUnderlying: 0,
    underlyingQty: 0,
  };
  const signed = row.side === 'buy' ? fillQuantity(row) : -fillQuantity(row);
  const size = Math.abs(signed);
  const price = row.filledPrice as number;
  // Rows predating the column (and any source reporting a junk price) must be
  // skipped rather than averaged in as zero, which would drag the anchor to a
  // level the position was never opened at.
  const underlying =
    typeof row.underlyingPrice === 'number' && Number.isFinite(row.underlyingPrice)
      ? row.underlyingPrice
      : null;
  let realized: number | null = null;

  if (position.quantity === 0 || Math.sign(position.quantity) === Math.sign(signed)) {
    // Opening or adding: blend the average cost.
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
    } else if (Math.sign(position.quantity) !== direction) {
      // Flipped: the remainder is a new position anchored on this fill.
      position.avgPrice = price;
      position.avgUnderlying = underlying ?? 0;
      position.underlyingQty = underlying === null ? 0 : Math.abs(position.quantity);
    } else {
      // Partially closed: the average is unchanged, but it now backs less size.
      position.underlyingQty = Math.min(position.underlyingQty, Math.abs(position.quantity));
    }
  }
  book.set(row.contractSymbol, position);
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
      underlyingPrice: underlyingPrice ?? null,
      status: order.status,
      placedAt: Number.isNaN(placedAt.getTime()) ? new Date() : placedAt,
    };
  }

  /** Upsert an order row; updates only fields a status change can move. */
  async record(userId: string, order: OrderResult): Promise<void> {
    await this.prisma.tradeOrder.upsert({
      where: { id: order.orderId },
      create: await this.createData(userId, order),
      update: {
        status: order.status,
        filledPrice: order.filledPrice ?? null,
        filledQuantity: order.filledQuantity ?? null,
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
    await this.prisma.tradeOrder.upsert({
      where: { id: order.orderId },
      create: await this.createData(userId, order, underlyingPrice),
      update: { underlyingPrice },
    });
  }

  /**
   * Quantity-weighted underlying price behind each of the given open contracts
   * — the level the chart draws a position's entry line at.
   *
   * Scoped to the contracts the broker actually reports open (and to the user's
   * current environment), so this replays a handful of fills rather than the
   * user's whole order history. Contracts with no recorded underlying price
   * (opened before the column existed, or outside the app) are omitted; the
   * clients fall back to stamping the live price locally.
   */
  async positionAnchors(userId: string, contractSymbols: string[]): Promise<Map<string, number>> {
    if (contractSymbols.length === 0) return new Map();
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const environment = user?.tradingMode === 'practice' ? 'practice' : 'live';
    const rows = await this.prisma.tradeOrder.findMany({
      where: { userId, environment, contractSymbol: { in: contractSymbols } },
      orderBy: { placedAt: 'asc' },
    });

    const book = new Map<string, BookEntry>();
    for (const row of rows) {
      if (isFill(row)) applyFill(book, row);
    }

    const anchors = new Map<string, number>();
    for (const [symbol, entry] of book) {
      if (entry.quantity !== 0 && entry.underlyingQty > 0) {
        anchors.set(symbol, round2(entry.avgUnderlying));
      }
    }
    return anchors;
  }

  async history(userId: string): Promise<TradeHistory> {
    const rows = await this.prisma.tradeOrder.findMany({
      where: { userId },
      orderBy: { placedAt: 'asc' },
    });

    // Average-cost realized P/L, computed per contract in fill order.
    const book = new Map<string, BookEntry>();
    let total = 0;
    const entries: TradeHistoryEntry[] = rows.map((row) => {
      const entry: TradeHistoryEntry = {
        orderId: row.id,
        status: row.status as TradeHistoryEntry['status'],
        contractSymbol: row.contractSymbol,
        side: row.side as TradeHistoryEntry['side'],
        quantity: row.quantity,
        orderType: row.orderType as TradeHistoryEntry['orderType'],
        limitPrice: row.limitPrice ?? undefined,
        filledPrice: row.filledPrice ?? undefined,
        timestamp: row.placedAt.toISOString(),
        realizedPnl: null,
      };
      if (!isFill(row)) return entry;

      const realized = applyFill(book, row);
      if (realized !== null) {
        entry.realizedPnl = realized;
        total += realized;
      }
      return entry;
    });

    return { entries: entries.reverse(), totalRealizedPnl: round2(total) };
  }
}
