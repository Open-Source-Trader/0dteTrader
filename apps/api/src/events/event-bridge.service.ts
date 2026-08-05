import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { OrderEventsService } from '../broker/order-events.service';
import { ChartOrderEventsService } from '../chart-orders/chart-order-events.service';
import { EventTransportService } from './event-transport.service';

/** Persists the two application event buses into the shared user-event log. */
@Injectable()
export class EventBridgeService implements OnModuleDestroy {
  private readonly unregister: Array<() => void>;

  constructor(
    orderEvents: OrderEventsService,
    chartOrderEvents: ChartOrderEventsService,
    transport: EventTransportService,
  ) {
    this.unregister = [
      orderEvents.registerIngestor((event) =>
        transport
          .publish(
            event.userId,
            'orderUpdate',
            event.order,
            [
              'order',
              event.provider ?? '',
              event.environment ?? '',
              event.accountId ?? '',
              // Prefer the client id when both exist: placement always knows
              // it, while a later provider update adds the broker id. This
              // keeps both observations on one semantic event identity.
              event.clientOrderId ?? event.brokerOrderId ?? event.order.orderId,
              event.order.status,
              event.order.filledQuantity ?? '',
              event.order.filledPrice ?? '',
            ].join(':'),
          )
          .then(() => undefined),
      ),
      chartOrderEvents.registerIngestor((event) =>
        transport
          .publish(
            event.userId,
            'chartOrder',
            event.order,
            `chart:${event.order.id}:${event.order.status}:${event.order.brokerOrderId ?? ''}`,
          )
          .then(() => undefined),
      ),
    ];
  }

  onModuleDestroy(): void {
    for (const unregister of this.unregister) unregister();
  }
}
