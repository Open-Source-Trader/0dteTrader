import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Real Prisma service used in dev/prod. In tests this provider is overridden
 * with the in-memory fake (test/in-memory-prisma.service.ts), so the app code
 * only ever uses the small delegate surface below (never $queryRaw,
 * transactions, or selects the fake cannot mirror):
 *   user:             findUnique, create, update
 *   webullCredential: upsert, findUnique, delete
 *   refreshToken:     create, findUnique, update, updateMany
 *   orderAudit:       findUnique, create, findMany
 *   optionsAnalyticsSnapshotRecord: create, findMany, deleteMany
 *   scheduledJobLease: create, updateMany
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
