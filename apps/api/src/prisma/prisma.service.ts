import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
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
  constructor() {
    // Prisma 7 requires a driver adapter for direct connections; DATABASE_URL
    // is already in process.env because ConfigModule.forRoot() runs dotenv
    // during module evaluation, before DI constructs this provider.
    super({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
