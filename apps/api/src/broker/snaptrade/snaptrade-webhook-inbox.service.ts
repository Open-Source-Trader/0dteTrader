import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, WebhookInbox } from '@prisma/client';
import { TradingMode } from '@0dtetrader/shared-types';
import { isUniqueViolation } from '../../common/api-exception';
import { PrismaService } from '../../prisma/prisma.service';
import { SnapTradeWebhookProcessorService } from './snaptrade-webhook-processor.service';

const POLL_MS = 500;
const LEASE_MS = 30_000;
const MAX_ATTEMPTS = 8;

@Injectable()
export class SnapTradeWebhookInboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SnapTradeWebhookInboxService.name);
  private readonly ownerId = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly processor: SnapTradeWebhookProcessorService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.processDue(), POLL_MS);
    this.timer.unref?.();
    void this.processDue();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The HTTP durability boundary. A duplicate provider id is a successful no-op. */
  async enqueue(input: {
    webhookId: string;
    userId: string;
    environment: TradingMode;
    accountId?: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.prisma.webhookInbox.create({
        data: {
          provider: 'snaptrade',
          webhookId: input.webhookId,
          userId: input.userId,
          environment: input.environment,
          accountId: input.accountId,
          eventType: input.eventType,
          payload: input.payload as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  /** Exposed for deterministic two-instance and lease-recovery tests. */
  async processDue(now = new Date()): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const candidate = await this.prisma.webhookInbox.findFirst({
          where: this.dueWhere(now),
          orderBy: { createdAt: 'asc' },
        });
        if (!candidate) break;
        const attempts = candidate.attempts + 1;
        const claimed = await this.prisma.webhookInbox.updateMany({
          where: { id: candidate.id, ...this.dueWhere(now) },
          data: {
            status: 'leased',
            attempts,
            leaseOwnerId: this.ownerId,
            leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
          },
        });
        if (claimed.count !== 1) continue;
        await this.processClaim(candidate, attempts, now);
      }
    } finally {
      this.draining = false;
    }
  }

  private dueWhere(now: Date) {
    return {
      OR: [
        { status: { in: ['pending', 'retry'] }, nextAttemptAt: { lte: now } },
        { status: 'leased', leaseExpiresAt: { lt: now } },
      ],
    };
  }

  private async processClaim(row: WebhookInbox, attempts: number, now: Date): Promise<void> {
    try {
      await this.processor.process(
        row.eventType,
        row.userId,
        row.environment as TradingMode,
        row.payload as Record<string, unknown>,
        row.webhookId,
      );
      await this.prisma.webhookInbox.updateMany({
        where: { id: row.id, status: 'leased', leaseOwnerId: this.ownerId },
        data: {
          status: 'processed',
          processedAt: now,
          leaseOwnerId: null,
          leaseExpiresAt: null,
          lastError: null,
          failureStage: null,
        },
      });
    } catch (error) {
      const terminal = attempts >= MAX_ATTEMPTS;
      await this.prisma.webhookInbox.updateMany({
        where: { id: row.id, status: 'leased', leaseOwnerId: this.ownerId },
        data: {
          status: terminal ? 'dead' : 'retry',
          nextAttemptAt: new Date(now.getTime() + this.backoffMs(attempts)),
          leaseOwnerId: null,
          leaseExpiresAt: null,
          lastError: (error as Error).message,
          failureStage: 'dispatch',
        },
      });
      this.logger.error(
        JSON.stringify({
          event: 'snaptrade_webhook_processing_failed',
          webhookId: row.webhookId,
          eventType: row.eventType,
          userId: row.userId,
          environment: row.environment,
          attempt: attempts,
          terminal,
          stage: 'dispatch',
          message: (error as Error).message,
        }),
      );
    }
  }

  private backoffMs(attempts: number): number {
    return Math.min(30 * 60_000, 1_000 * 2 ** Math.max(0, attempts - 1));
  }
}
