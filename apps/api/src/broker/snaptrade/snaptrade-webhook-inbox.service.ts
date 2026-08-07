import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, WebhookInbox } from '@prisma/client';
import { TradingMode } from '@0dtetrader/shared-types';
import { isUniqueViolation } from '../../common/api-exception';
import { PrismaService } from '../../prisma/prisma.service';
import { SnapTradeWebhookProcessorService } from './snaptrade-webhook-processor.service';

const POLL_MS = 500;
const LEASE_MS = 30_000;
const LEASE_RENEW_MS = 10_000;
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
    this.timer = setInterval(() => this.kickWorker(), POLL_MS);
    this.timer.unref?.();
    this.kickWorker();
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
          // Null is meaningful: the receiver could not safely snapshot a
          // single account. The worker must not later reinterpret mutable
          // connection state after a multi-account delivery has aged.
          accountId: input.accountId ?? null,
          eventType: input.eventType,
          payload: input.payload as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  /** Lets the authenticated HTTP path acknowledge a provider redelivery even
   * after its signed timestamp has aged outside the replay window. */
  async exists(webhookId: string): Promise<boolean> {
    const row = await this.prisma.webhookInbox.findUnique({
      where: {
        provider_webhookId: { provider: 'snaptrade', webhookId },
      },
    });
    return row !== null;
  }

  /** Exposed for deterministic two-instance and lease-recovery tests. */
  async processDue(nowOverride?: Date): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        // A production drain may take much longer than one lease. Read the
        // clock for every candidate instead of making all rows share the time
        // at which the drain happened to start. The override is deliberately
        // fixed for deterministic unit tests only.
        const scanNow = nowOverride ?? new Date();
        const candidate = await this.prisma.webhookInbox.findFirst({
          where: this.dueWhere(scanNow),
          orderBy: { createdAt: 'asc' },
        });
        if (!candidate) break;
        const attempts = candidate.attempts + 1;
        const claimNow = nowOverride ?? new Date();
        const claimed = await this.prisma.webhookInbox.updateMany({
          where: { id: candidate.id, ...this.dueWhere(claimNow) },
          data: {
            status: 'leased',
            attempts,
            leaseOwnerId: this.ownerId,
            leaseExpiresAt: new Date(claimNow.getTime() + LEASE_MS),
          },
        });
        if (claimed.count !== 1) continue;
        await this.processClaim(candidate, attempts, nowOverride);
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

  private async processClaim(
    row: WebhookInbox,
    attempts: number,
    nowOverride?: Date,
  ): Promise<void> {
    // Dispatch can legitimately outlive the initial 30-second claim (broker
    // and database calls are both involved). Renew while it is in flight so a
    // second API instance cannot take the same webhook and duplicate effects.
    const heartbeat = setInterval(() => {
      const renewedAt = nowOverride ?? new Date();
      void this.prisma.webhookInbox
        .updateMany({
          where: { id: row.id, status: 'leased', leaseOwnerId: this.ownerId },
          data: { leaseExpiresAt: new Date(renewedAt.getTime() + LEASE_MS) },
        })
        .catch((error: unknown) =>
          this.logger.error(
            `webhook lease renewal failed: webhookId=${row.webhookId} ` +
              `message=${(error as Error).message}`,
          ),
        );
    }, LEASE_RENEW_MS);
    heartbeat.unref?.();
    try {
      await this.processor.process(
        row.eventType,
        row.userId,
        row.environment as TradingMode,
        row.payload as Record<string, unknown>,
        row.webhookId,
        row.accountId,
      );
      clearInterval(heartbeat);
      const completedAt = nowOverride ?? new Date();
      await this.prisma.webhookInbox.updateMany({
        where: { id: row.id, status: 'leased', leaseOwnerId: this.ownerId },
        data: {
          status: 'processed',
          processedAt: completedAt,
          leaseOwnerId: null,
          leaseExpiresAt: null,
          lastError: null,
          failureStage: null,
        },
      });
    } catch (error) {
      clearInterval(heartbeat);
      const failedAt = nowOverride ?? new Date();
      const terminal = attempts >= MAX_ATTEMPTS;
      await this.prisma.webhookInbox.updateMany({
        where: { id: row.id, status: 'leased', leaseOwnerId: this.ownerId },
        data: {
          status: terminal ? 'dead' : 'retry',
          nextAttemptAt: new Date(failedAt.getTime() + this.backoffMs(attempts)),
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

  private kickWorker(): void {
    void this.processDue().catch((error: unknown) =>
      this.logger.error(`webhook inbox drain failed: ${(error as Error).message}`),
    );
  }

  private backoffMs(attempts: number): number {
    return Math.min(30 * 60_000, 1_000 * 2 ** Math.max(0, attempts - 1));
  }
}
