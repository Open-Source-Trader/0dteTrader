import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';
import { OrderResult } from '@0dtetrader/shared-types';

export interface OrderUpdateEvent {
  userId: string;
  order: OrderResult;
}

/**
 * In-process bus carrying order status changes from the broker gateway to the
 * WebSocket stream gateway (server → client `orderUpdate` messages).
 */
@Injectable()
export class OrderEventsService {
  private readonly subject = new Subject<OrderUpdateEvent>();
  readonly events$ = this.subject.asObservable();

  emit(userId: string, order: OrderResult): void {
    this.subject.next({ userId, order });
  }
}
