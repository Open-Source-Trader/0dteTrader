import { createHash } from 'node:crypto';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { OrderEventsService, OrderUpdateEvent } from '../broker/order-events.service';
import { ChartOrderEventsService } from '../chart-orders/chart-order-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { EventTransportService } from './event-transport.service';

/** Persists the two application event buses into the shared user-event log. */
@Injectable()
export class EventBridgeService implements OnModuleDestroy {
  private readonly unregister: Array<() => void>;

  constructor(
    orderEvents: OrderEventsService,
    chartOrderEvents: ChartOrderEventsService,
    transport: EventTransportService,
    private readonly prisma: PrismaService,
  ) {
    this.unregister = [
      orderEvents.registerIngestor(async (event) => {
        const persistedId = await this.resolvePersistedOrderId(event);
        const fallbackIdentity = [
          event.provider ?? '',
          event.environment ?? '',
          event.accountId ?? '',
          event.clientOrderId ?? event.brokerOrderId ?? event.order.orderId,
        ].join(':');
        await transport.publish(
          event.userId,
          'orderUpdate',
          event.order,
          [
            'order',
            // OrdersService runs first (priority 100), so the internal UUID is
            // available here and remains stable as client and broker aliases
            // are learned. The scoped external shape is only a conservative
            // fallback for legacy emitters whose persisted row is ambiguous.
            persistedId ?? fallbackIdentity,
            event.order.status,
            event.order.filledQuantity ?? '',
            event.order.filledPrice ?? '',
            event.order.filledAt ?? '',
          ].join(':'),
        );
      }),
      chartOrderEvents.registerIngestor((event) =>
        transport
          .publish(event.userId, 'chartOrder', event.order, this.chartDedupeKey(event.order))
          .then(() => undefined),
      ),
    ];
  }

  onModuleDestroy(): void {
    for (const unregister of this.unregister) unregister();
  }

  private chartDedupeKey(order: {
    id: string;
    quantity: number;
    triggerPrice: number;
    armPrice: number;
    orderType: string;
    status: string;
    brokerOrderId: string | null;
    triggeredAt: string | null;
    lastError: string | null;
  }): string {
    // Every mutable field the clients render/act on participates. Hashing the
    // canonical property order avoids delimiter collisions in free-form
    // lastError while keeping the indexed key compact.
    const version = JSON.stringify({
      quantity: order.quantity,
      triggerPrice: order.triggerPrice,
      armPrice: order.armPrice,
      orderType: order.orderType,
      status: order.status,
      brokerOrderId: order.brokerOrderId,
      triggeredAt: order.triggeredAt,
      lastError: order.lastError,
    });
    return `chart:${order.id}:${createHash('sha256').update(version).digest('hex')}`;
  }

  private async resolvePersistedOrderId(event: OrderUpdateEvent): Promise<string | null> {
    const identifiers = [event.brokerOrderId, event.clientOrderId, event.order.orderId]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    const uniqueIdentifiers = [...new Set(identifiers)];
    if (uniqueIdentifiers.length === 0) return null;

    const rows = await this.prisma.tradeOrder.findMany({
      where: {
        userId: event.userId,
        ...(event.provider ? { provider: event.provider } : {}),
        ...(event.environment ? { environment: event.environment } : {}),
        ...(event.accountId ? { accountId: event.accountId } : {}),
        OR: uniqueIdentifiers.flatMap((identifier) => [
          { brokerOrderId: identifier },
          { clientOrderId: identifier },
        ]),
      },
      select: { id: true },
      take: 2,
    });
    // Refuse to guess across tenants/scopes when an older emitter did not
    // provide enough identity. A scoped fallback key is safer than joining
    // two distinct orders into one durable event.
    return rows.length === 1 ? rows[0].id : null;
  }
}
