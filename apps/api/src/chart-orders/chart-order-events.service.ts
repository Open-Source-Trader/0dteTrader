import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';
import { ChartOrder } from '@0dtetrader/shared-types';

export interface ChartOrderUpdateEvent {
  userId: string;
  order: ChartOrder;
}

export type ChartOrderUpdateIngestor = (event: ChartOrderUpdateEvent) => Promise<void>;

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
  private readonly ingestors = new Set<ChartOrderUpdateIngestor>();

  registerIngestor(ingestor: ChartOrderUpdateIngestor): () => void {
    this.ingestors.add(ingestor);
    return () => this.ingestors.delete(ingestor);
  }

  emit(userId: string, order: ChartOrder): void {
    const event = { userId, order };
    void this.runIngestors(event)
      .then(() => this.subject.next(event))
      .catch(() => undefined);
  }

  private async runIngestors(event: ChartOrderUpdateEvent): Promise<void> {
    for (const ingestor of this.ingestors) await ingestor(event);
  }
}
