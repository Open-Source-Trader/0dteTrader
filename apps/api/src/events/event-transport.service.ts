import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { UserEvent } from '@prisma/client';
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
 * Postgres-backed event transport. The table is the durable event log and polling
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
  private pollPromise: Promise<void> | null = null;
  private pollRequested = false;
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    const latest = await this.prisma.userEvent.findFirst({ orderBy: { ordinal: 'desc' } });
    this.lastOrdinal = latest?.ordinal ?? 0n;
    await this.pollSafely('initial');
    this.timer = setInterval(() => void this.pollSafely('scheduled'), POLL_MS);
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
    const row = await this.prisma.$transaction(
      async (database) => {
        // This singleton is the commit-order barrier for every publisher. The
        // update takes a row lock which remains held until this transaction has
        // inserted its event and commits. Thus a greater ordinal can never be
        // visible before a smaller one, and the same lock also makes the user's
        // next sequence allocation race-free.
        const allocation = await database.eventTransportState.upsert({
          where: { name: 'global' },
          create: { name: 'global', nextOrdinal: 2n },
          update: { nextOrdinal: { increment: 1n } },
        });
        const ordinal = allocation.nextOrdinal - 1n;

        if (dedupeKey) {
          const existing = await database.userEvent.findUnique({
            where: { userId_dedupeKey: { userId, dedupeKey } },
          });
          if (existing) return existing;
        }

        const latest = await database.userEvent.findFirst({
          where: { userId },
          orderBy: { sequence: 'desc' },
        });
        return database.userEvent.create({
          data: {
            ordinal,
            userId,
            sequence: (latest?.sequence ?? 0) + 1,
            dedupeKey,
            type,
            payload: JSON.parse(JSON.stringify(payload)),
          },
        });
      },
      // A burst queues behind the singleton by design; the default 2s maxWait
      // is too short for a healthy but busy publisher cohort.
      { maxWait: 10_000, timeout: 10_000 },
    );
    const event = this.toEvent(row);
    // Do not fan out directly: polling preserves global commit order on every
    // instance. A transient poll failure must not turn a committed publish
    // into an application-level failure; the scheduled poll will retry it.
    await this.pollSafely('publish');
    return event;
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
    this.pollRequested = true;
    if (!this.pollPromise) {
      this.pollPromise = this.runPollLoop().finally(() => {
        this.pollPromise = null;
      });
    }
    return this.pollPromise;
  }

  private async runPollLoop(): Promise<void> {
    do {
      this.pollRequested = false;
      await this.drainAvailableRows();
    } while (this.pollRequested);
  }

  private async drainAvailableRows(): Promise<void> {
    for (;;) {
      const rows = await this.prisma.userEvent.findMany({
        where: { ordinal: { gt: this.lastOrdinal } },
        orderBy: { ordinal: 'asc' },
        take: 500,
      });
      for (const row of rows) {
        if (row.ordinal > this.lastOrdinal) this.lastOrdinal = row.ordinal;
        this.emitUnseen(this.toEvent(row));
      }
      if (rows.length < 500) return;
    }
  }

  private async pollSafely(context: 'initial' | 'scheduled' | 'publish'): Promise<void> {
    try {
      await this.pollOnce();
    } catch (error) {
      this.logger.warn(`user-event ${context} poll failed: ${(error as Error).message}`);
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
