import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';
import { ChartOrder } from '@0dtetrader/shared-types';

export interface ChartOrderUpdateEvent {
  userId: string;
  order: ChartOrder;
}

/**
 * In-process bus carrying chart-order state changes from the server-side
 * watcher to the WebSocket stream gateway (server → client `chartOrder`
 * messages), mirroring OrderEventsService. Keeping the direction one-way lets
 * MarketDataModule depend on ChartOrdersModule without a cycle.
 */
@Injectable()
export class ChartOrderEventsService {
  private readonly subject = new Subject<ChartOrderUpdateEvent>();
  readonly events$ = this.subject.asObservable();

  emit(userId: string, order: ChartOrder): void {
    this.subject.next({ userId, order });
  }
}
