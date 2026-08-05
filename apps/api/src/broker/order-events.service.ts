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

/** Persists an order update. Registered by OrdersService; throws when the
 *  update could not be persisted (after its own bounded retries). */
export type OrderUpdateIngestor = (event: OrderUpdateEvent) => Promise<void>;

/**
 * In-process bus carrying order status changes from the broker gateways to
 * the recorder, the WebSocket stream gateway and push notifications.
 *
 * Two delivery modes, because callers have different durability needs:
 *
 * - `emit` is fire-and-forget, for gateway polls and placement paths whose
 *   caller cannot usefully wait (a poll tick has no one to report failure
 *   to). Ingestors run concurrently with fan-out and handle their own
 *   retries and logging.
 * - `ingest` is AWAITED, for the webhook path: an HTTP 2xx acknowledges the
 *   event to a provider that would otherwise retry it, so the
 *   acknowledgement must not outrun persistence. It resolves only after
 *   every ingestor has persisted, fans out to subscribers only on success,
 *   and rethrows failure so the controller can answer 5xx and get the
 *   provider's documented redelivery. An RxJS Subject cannot await its
 *   subscribers, which is why persistence rides registered ingestors rather
 *   than the subscription.
 */
@Injectable()
export class OrderEventsService {
  private readonly subject = new Subject<OrderUpdateEvent>();
  readonly events$ = this.subject.asObservable();
  private readonly ingestors = new Set<OrderUpdateIngestor>();

  registerIngestor(ingestor: OrderUpdateIngestor): () => void {
    this.ingestors.add(ingestor);
    return () => this.ingestors.delete(ingestor);
  }

  emit(userId: string, order: OrderResult, environment?: TradingMode): void {
    const event: OrderUpdateEvent = { userId, order, environment };
    for (const ingestor of this.ingestors) {
      // Exhaustion is already logged where it happens; a fire-and-forget
      // caller has nothing further to do with it.
      void ingestor(event).catch(() => undefined);
    }
    this.subject.next(event);
  }

  async ingest(userId: string, order: OrderResult, environment?: TradingMode): Promise<void> {
    const event: OrderUpdateEvent = { userId, order, environment };
    for (const ingestor of this.ingestors) {
      await ingestor(event);
    }
    this.subject.next(event);
  }
}
