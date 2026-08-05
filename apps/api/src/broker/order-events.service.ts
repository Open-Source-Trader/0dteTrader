import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';
import { OrderResult, TradingMode } from '@0dtetrader/shared-types';

export interface OrderUpdateEvent {
  userId: string;
  order: OrderResult;
  /**
   * The environment the order was actually placed in, when the emitter knows
   * it for certain — a webhook resolves it from the credential the event was
   * signed with. Absent when the emitter has no better answer than the
   * user's current mode.
   *
   * It matters because the user's trading mode is mutable and the recorder
   * falls back to it: a live fill arriving after a switch to practice would
   * otherwise be persisted and announced as practice, and an order's
   * environment is stamped once and never moves.
   */
  environment?: TradingMode;
}

/**
 * In-process bus carrying order status changes from the broker gateway to the
 * WebSocket stream gateway (server → client `orderUpdate` messages).
 */
@Injectable()
export class OrderEventsService {
  private readonly subject = new Subject<OrderUpdateEvent>();
  readonly events$ = this.subject.asObservable();

  emit(userId: string, order: OrderResult, environment?: TradingMode): void {
    this.subject.next({ userId, order, environment });
  }
}
