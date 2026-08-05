import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { UserEvent } from '@prisma/client';
import { isUniqueViolation } from '../common/api-exception';
import { PrismaService } from '../prisma/prisma.service';

export type DurableEventType = 'orderUpdate' | 'chartOrder';

export interface DurableUserEvent {
  id: string;
  userId: string;
  sequence: number;
  type: DurableEventType;
  payload: unknown;
}

const POLL_MS = 250;
const SEEN_LIMIT = 2_048;

/**
 * Postgres-backed event transport. The table is the durable outbox and polling
 * is the shared transport: it needs no Redis policy decision and, unlike
 * LISTEN/NOTIFY alone, reconnect catch-up is inherent.
 */
@Injectable()
export class EventTransportService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventTransportService.name);
  private readonly subject = new Subject<DurableUserEvent>();
  readonly events$ = this.subject.asObservable();
  private timer: NodeJS.Timeout | null = null;
  private lastOrdinal = 0n;
  private polling = false;
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    const latest = await this.prisma.userEvent.findFirst({ orderBy: { ordinal: 'desc' } });
    this.lastOrdinal = latest?.ordinal ?? 0n;
    this.timer = setInterval(() => void this.pollOnce(), POLL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async publish(
    userId: string,
    type: DurableEventType,
    payload: unknown,
    dedupeKey?: string,
  ): Promise<DurableUserEvent> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const latest = await this.prisma.userEvent.findFirst({
        where: { userId },
        orderBy: { sequence: 'desc' },
      });
      try {
        const row = await this.prisma.userEvent.create({
          data: {
            userId,
            sequence: (latest?.sequence ?? 0) + 1,
            dedupeKey,
            type,
            payload: JSON.parse(JSON.stringify(payload)),
          },
        });
        const event = this.toEvent(row);
        // Never emit the just-created row directly. Another instance may have
        // committed an earlier per-user sequence that this process has not
        // polled yet; direct local fan-out would then deliver N+1 before N and
        // make the socket cursor permanently discard N. Polling by the global
        // ordinal drains every earlier row first and still gives local
        // publishers near-immediate delivery.
        await this.pollOnce();
        return event;
      } catch (error) {
        if (!isUniqueViolation(error) || attempt === 7) throw error;
        if (dedupeKey) {
          const existing = await this.prisma.userEvent.findUnique({
            where: { userId_dedupeKey: { userId, dedupeKey } },
          });
          if (existing) return this.toEvent(existing);
        }
      }
    }
    throw new Error('could not allocate user event sequence');
  }

  async replay(userId: string, afterSequence: number, limit = 1_000): Promise<DurableUserEvent[]> {
    const rows = await this.prisma.userEvent.findMany({
      where: { userId, sequence: { gt: Math.max(0, afterSequence) } },
      orderBy: { sequence: 'asc' },
      take: limit,
    });
    return rows.map((row) => this.toEvent(row));
  }

  async latestSequence(userId: string): Promise<number> {
    const latest = await this.prisma.userEvent.findFirst({
      where: { userId },
      orderBy: { sequence: 'desc' },
    });
    return latest?.sequence ?? 0;
  }

  /** Exposed for deterministic two-instance tests. */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const rows = await this.prisma.userEvent.findMany({
        where: { ordinal: { gt: this.lastOrdinal } },
        orderBy: { ordinal: 'asc' },
        take: 500,
      });
      for (const row of rows) {
        if (row.ordinal > this.lastOrdinal) this.lastOrdinal = row.ordinal;
        this.emitUnseen(this.toEvent(row));
      }
    } catch (error) {
      this.logger.warn(`user-event poll failed: ${(error as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  private toEvent(row: UserEvent): DurableUserEvent {
    return {
      id: row.id,
      userId: row.userId,
      sequence: row.sequence,
      type: row.type as DurableEventType,
      payload: row.payload,
    };
  }

  private emitUnseen(event: DurableUserEvent): void {
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id);
    this.seenOrder.push(event.id);
    if (this.seenOrder.length > SEEN_LIMIT) {
      const removed = this.seenOrder.shift();
      if (removed) this.seen.delete(removed);
    }
    this.subject.next(event);
  }
}
