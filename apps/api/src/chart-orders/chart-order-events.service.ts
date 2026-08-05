import { Injectable, Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { ChartOrder } from '@0dtetrader/shared-types';

export interface ChartOrderUpdateEvent {
  userId: string;
  order: ChartOrder;
}

export type ChartOrderUpdateIngestor = (event: ChartOrderUpdateEvent) => Promise<void>;

const INGEST_ATTEMPTS = 3;
const INGEST_RETRY_BASE_MS = 25;

function sanitizedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 200) || 'unknown ingestion failure';
}

/**
 * In-process bus carrying chart-order state changes from the server-side
 * watcher to the WebSocket stream gateway (server → client `chartOrder`
 * messages), mirroring OrderEventsService. Keeping the direction one-way lets
 * MarketDataModule depend on ChartOrdersModule without a cycle.
 */
@Injectable()
export class ChartOrderEventsService {
  private readonly logger = new Logger(ChartOrderEventsService.name);
  private readonly subject = new Subject<ChartOrderUpdateEvent>();
  readonly events$ = this.subject.asObservable();
  private readonly ingestors = new Set<ChartOrderUpdateIngestor>();
  private readonly userQueues = new Map<string, Promise<void>>();

  registerIngestor(ingestor: ChartOrderUpdateIngestor): () => void {
    this.ingestors.add(ingestor);
    return () => this.ingestors.delete(ingestor);
  }

  emit(userId: string, order: ChartOrder): void {
    const event = { userId, order };
    // Fire-and-forget producers share the same per-user queue as awaited
    // ingestion. processWithRetry logs exhaustion before this detached
    // rejection is consumed.
    void this.enqueue(event).catch(() => undefined);
  }

  async ingest(userId: string, order: ChartOrder): Promise<void> {
    await this.enqueue({ userId, order });
  }

  private enqueue(event: ChartOrderUpdateEvent): Promise<void> {
    const previous = this.userQueues.get(event.userId);
    const ingestors = [...this.ingestors];
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
    event: ChartOrderUpdateEvent,
    ingestors: ChartOrderUpdateIngestor[],
  ): Promise<void> {
    for (let attempt = 1; attempt <= INGEST_ATTEMPTS; attempt += 1) {
      try {
        for (const ingestor of ingestors) await ingestor(event);
        this.subject.next(event);
        return;
      } catch (error) {
        const detail = sanitizedError(error);
        if (attempt === INGEST_ATTEMPTS) {
          this.logger.error(
            `chart-order event ingestion exhausted ${INGEST_ATTEMPTS} attempts: ${detail}`,
          );
          throw error;
        }
        this.logger.warn(
          `chart-order event ingestion attempt ${attempt}/${INGEST_ATTEMPTS} failed; retrying: ${detail}`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, INGEST_RETRY_BASE_MS * 2 ** (attempt - 1)),
        );
      }
    }
  }
}
