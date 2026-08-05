import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Real Prisma service used in dev/prod. In tests this provider is overridden
 * with the in-memory fake (test/in-memory-prisma.service.ts), so the app code
 * only ever uses the small delegate surface below (plus parameterized row-lock
 * SQL for identity merges, mirrored as serialized transactions by the fake).
 * The test double also implements callback
 * transactions for the bracket state machine:
 *   user:             findUnique, findMany, create, update
 *   webullCredential: upsert, findUnique, delete
 *   refreshToken:     create, findUnique, update, updateMany
 *   orderAudit:       findUnique, create, update, delete, findMany
 *   tradeOrder:       findUnique, findFirst, upsert, findMany, updateMany, delete
 *   tradeOrderExecution: create, findMany
 *   chartOrder:       create, findUnique, findFirst, findMany, count, update, updateMany
 *   bracketGroup:     create, upsert, findUnique, findFirst, findMany, update, updateMany
 *   optionsAnalyticsSnapshotRecord: create, findMany, deleteMany
 *   scheduledJobLease: findUnique, create, updateMany
 *   brokerCredential: findUnique, findMany, upsert, delete
 *   brokerApiToken:   findUnique, upsert, deleteMany
 *   brokerConnection: findUnique, findMany, updateMany, upsert, delete, deleteMany
 *   deviceToken:      findMany, upsert, deleteMany
 *   pushDelivery:     create, findFirst, deleteMany
 *   userEvent:        create, findUnique, findFirst, findMany
 *   eventTransportState: upsert
 *   discordDelivery:  create, findFirst, update, deleteMany
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
