import { Injectable, Logger } from '@nestjs/common';
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
  /** Stable external identity scope. Older emitters may omit it; recorders use
   * conservative per-user defaults until that gateway supplies the scope. */
  provider?: 'webull' | 'alpaca' | 'snaptrade';
  accountId?: string;
  brokerOrderId?: string;
  clientOrderId?: string;
  sourceEventId?: string;
}

/** Persists an order update. Registered by OrdersService; throws when the
 *  update could not be persisted (after its own bounded retries). */
export type OrderUpdateIngestor = (event: OrderUpdateEvent) => Promise<void>;

const INGEST_ATTEMPTS = 3;
const INGEST_RETRY_BASE_MS = 25;

function sanitizedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 200) || 'unknown ingestion failure';
}

/**
 * In-process bus carrying order status changes from the broker gateways to
 * the recorder, the WebSocket stream gateway and push notifications.
 *
 * Two delivery modes, because callers have different durability needs:
 *
 * - `emit` is fire-and-forget for placement/cancel paths whose caller must not
 *   receive a failure after the broker has already mutated state. It still
 *   enters the per-user ingestion queue and gets the same bounded retries and
 *   sanitized failure logging as awaited work.
 * - `ingest` is AWAITED, for the webhook path: an HTTP 2xx acknowledges the
 *   event to a provider that would otherwise retry it, so the
 *   acknowledgement must not outrun persistence. It resolves only after
 *   every ingestor has persisted, fans out to subscribers only on success,
 *   and rethrows failure so the controller can answer 5xx and get the
 *   provider's documented redelivery. An RxJS Subject cannot await its
 *   subscribers, which is why persistence rides registered ingestors rather
 *   than the subscription. Both modes serialize per user, so a delayed
 *   submitted event cannot be overtaken by its terminal update.
 */
@Injectable()
export class OrderEventsService {
  private readonly logger = new Logger(OrderEventsService.name);
  private readonly subject = new Subject<OrderUpdateEvent>();
  readonly events$ = this.subject.asObservable();
  private readonly ingestors: Array<{ ingestor: OrderUpdateIngestor; priority: number }> = [];
  /** Per-user tails keep submitted → partial → terminal observations ordered
   *  even when one durable ingestor is slow or temporarily unavailable. */
  private readonly userQueues = new Map<string, Promise<void>>();

  registerIngestor(ingestor: OrderUpdateIngestor, priority = 0): () => void {
    const entry = { ingestor, priority };
    this.ingestors.push(entry);
    this.ingestors.sort((left, right) => right.priority - left.priority);
    return () => {
      const index = this.ingestors.indexOf(entry);
      if (index >= 0) this.ingestors.splice(index, 1);
    };
  }

  emit(
    userId: string,
    order: OrderResult,
    environment?: TradingMode,
    identity: Omit<OrderUpdateEvent, 'userId' | 'order' | 'environment'> = {},
  ): void {
    const event: OrderUpdateEvent = { userId, order, environment, ...identity };
    // Nonblocking callers still enter the same ordered queue as awaited
    // webhook/poll ingestion. Exhaustion is logged inside processWithRetry;
    // this rejection handler exists only to prevent a detached promise from
    // becoming an unhandled rejection.
    void this.enqueue(event).catch(() => undefined);
  }

  async ingest(
    userId: string,
    order: OrderResult,
    environment?: TradingMode,
    identity: Omit<OrderUpdateEvent, 'userId' | 'order' | 'environment'> = {},
  ): Promise<void> {
    const event: OrderUpdateEvent = { userId, order, environment, ...identity };
    await this.enqueue(event);
  }

  private enqueue(event: OrderUpdateEvent): Promise<void> {
    const previous = this.userQueues.get(event.userId);
    // Membership is part of the emission boundary: an ingestor registered
    // later must not retroactively observe an older queued event, and one
    // unregistered while waiting must still finish the event it accepted.
    const ingestors = [...this.ingestors];
    // A permanently failed predecessor has already exhausted and logged its
    // bounded retries. Let the next observation proceed, but never overtake it.
    const current = previous
      ? previous.catch(() => undefined).then(() => this.processWithRetry(event, ingestors))
      : this.processWithRetry(event, ingestors);
    this.userQueues.set(event.userId, current);
    void current.then(
      () => this.clearQueue(event.userId, current),
      () => this.clearQueue(event.userId, current),
    );
    return current;
  }

  private clearQueue(userId: string, current: Promise<void>): void {
    if (this.userQueues.get(userId) === current) this.userQueues.delete(userId);
  }

  private async processWithRetry(
    event: OrderUpdateEvent,
    ingestors: Array<{ ingestor: OrderUpdateIngestor; priority: number }>,
  ): Promise<void> {
    for (let attempt = 1; attempt <= INGEST_ATTEMPTS; attempt += 1) {
      try {
        // Preserve ingestor priority on every attempt. Re-running a successful
        // prefix is intentional: durable ingestors use stable unique keys, so
        // replay is idempotent and can repair a partially completed chain.
        for (const { ingestor } of ingestors) await ingestor(event);
        this.subject.next(event);
        return;
      } catch (error) {
        const detail = sanitizedError(error);
        if (attempt === INGEST_ATTEMPTS) {
          this.logger.error(
            `order event ingestion exhausted ${INGEST_ATTEMPTS} attempts: ${detail}`,
          );
          throw error;
        }
        this.logger.warn(
          `order event ingestion attempt ${attempt}/${INGEST_ATTEMPTS} failed; retrying: ${detail}`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, INGEST_RETRY_BASE_MS * 2 ** (attempt - 1)),
        );
      }
    }
  }
}
