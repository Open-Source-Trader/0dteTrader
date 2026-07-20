import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Subscription } from 'rxjs';
import { OrderResult, TradeHistory, TradeHistoryEntry } from '@0dtetrader/shared-types';
import { OPTION_MULTIPLIER } from '../broker/contract-resolution';
import { OrderEventsService } from '../broker/order-events.service';
import { PrismaService } from '../prisma/prisma.service';

const round2 = (v: number): number => Math.round(v * 100) / 100;

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

  /** Upsert an order row; updates only fields a status change can move. */
  async record(userId: string, order: OrderResult): Promise<void> {
    const placedAt = new Date(order.timestamp);
    // Stamp the environment (live/practice) in effect when the order is first
    // recorded; later status updates never move an order across environments.
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const environment = user?.tradingMode === 'practice' ? 'practice' : 'live';
    await this.prisma.tradeOrder.upsert({
      where: { id: order.orderId },
      create: {
        id: order.orderId,
        userId,
        contractSymbol: order.contractSymbol,
        assetClass: 'option',
        environment,
        side: order.side,
        quantity: order.quantity,
        filledQuantity: order.filledQuantity ?? null,
        orderType: order.orderType,
        limitPrice: order.limitPrice ?? null,
        filledPrice: order.filledPrice ?? null,
        status: order.status,
        placedAt: Number.isNaN(placedAt.getTime()) ? new Date() : placedAt,
      },
      update: {
        status: order.status,
        filledPrice: order.filledPrice ?? null,
        filledQuantity: order.filledQuantity ?? null,
      },
    });
  }

  async history(userId: string): Promise<TradeHistory> {
    const rows = await this.prisma.tradeOrder.findMany({
      where: { userId },
      orderBy: { placedAt: 'asc' },
    });

    // Average-cost realized P/L, computed per contract in fill order.
    const book = new Map<string, { quantity: number; avgPrice: number }>();
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
      // Executed quantity: the broker-reported filled amount when present
      // (a partial fill at the full order quantity would overstate both the
      // position book and realized P/L). A cancelled order with a recorded
      // filled quantity executed that portion before cancelling — it is a
      // real fill for accounting purposes.
      const filledQty = row.filledQuantity ?? row.quantity;
      const isFill =
        row.filledPrice !== null &&
        (row.status === 'filled' ||
          row.status === 'partially_filled' ||
          (row.status === 'cancelled' && row.filledQuantity !== null && row.filledQuantity > 0));
      if (!isFill) return entry;

      const multiplier = OPTION_MULTIPLIER;
      const position = book.get(row.contractSymbol) ?? { quantity: 0, avgPrice: 0 };
      const signed = row.side === 'buy' ? filledQty : -filledQty;
      const price = row.filledPrice as number;

      if (position.quantity === 0 || Math.sign(position.quantity) === Math.sign(signed)) {
        // Opening or adding: blend the average cost.
        const totalQty = Math.abs(position.quantity) + Math.abs(signed);
        position.avgPrice =
          (position.avgPrice * Math.abs(position.quantity) + price * Math.abs(signed)) / totalQty;
        position.quantity += signed;
      } else {
        // Reducing (or flipping through zero): realize on the closed quantity.
        const closed = Math.min(Math.abs(signed), Math.abs(position.quantity));
        const direction = Math.sign(position.quantity);
        const realized = round2((price - position.avgPrice) * closed * direction * multiplier);
        entry.realizedPnl = realized;
        total += realized;
        position.quantity += signed;
        if (position.quantity === 0) position.avgPrice = 0;
        else if (Math.sign(position.quantity) !== direction) position.avgPrice = price;
      }
      book.set(row.contractSymbol, position);
      return entry;
    });

    return { entries: entries.reverse(), totalRealizedPnl: round2(total) };
  }
}
