import { randomUUID } from 'node:crypto';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * In-memory stand-in for PrismaService, used by unit and e2e tests so the
 * suite runs without Postgres. It mirrors exactly the delegate surface the
 * app uses (documented on PrismaService) and emulates:
 *   - @default(uuid()) / @default(now()) / @updatedAt
 *   - unique constraints on user.email, refreshToken.tokenHash,
 *     webullCredential.userId and orderAudit.(userId, idempotencyKey)
 *     (violations throw a P2002-coded error like the real client)
 *   - nullable unique column semantics for orderAudit.idempotencyKey
 *     (multiple NULL keys never conflict, as in Postgres)
 *
 * It is injected via `overrideProvider(PrismaService).useValue(fake)`, so it
 * intentionally does not extend PrismaClient.
 */

function p2002(target: string): Error {
  return Object.assign(
    new Error(`Unique constraint failed on the fields: (${target})`),
    { code: 'P2002' },
  );
}

function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, value]) => {
    if (value === null) return row[key] === null || row[key] === undefined;
    if (typeof value === 'object') return false; // unsupported operator
    return row[key] === value;
  });
}

export class InMemoryPrismaService {
  readonly users: any[] = [];
  readonly credentials: any[] = [];
  readonly refreshTokens: any[] = [];
  readonly orderAudits: any[] = [];

  readonly user = {
    findUnique: async ({ where }: any) => {
      if (where.email !== undefined) {
        return this.users.find((u) => u.email === where.email) ?? null;
      }
      return this.users.find((u) => u.id === where.id) ?? null;
    },
    create: async ({ data }: any) => {
      if (this.users.some((u) => u.email === data.email)) throw p2002('email');
      const now = new Date();
      const row = {
        id: randomUUID(),
        tradingDisabled: false,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      this.users.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = this.users.find((u) => u.id === where.id);
      if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
  };

  readonly webullCredential = {
    findUnique: async ({ where }: any) =>
      this.credentials.find((c) => c.userId === where.userId) ?? null,
    upsert: async ({ where, create, update }: any) => {
      const existing = this.credentials.find((c) => c.userId === where.userId);
      if (existing) {
        Object.assign(existing, update, { updatedAt: new Date() });
        return existing;
      }
      const now = new Date();
      const row = {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        ...create,
      };
      this.credentials.push(row);
      return row;
    },
    delete: async ({ where }: any) => {
      const idx = this.credentials.findIndex((c) => c.userId === where.userId);
      if (idx === -1) {
        throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      }
      const [row] = this.credentials.splice(idx, 1);
      return row;
    },
  };

  readonly refreshToken = {
    create: async ({ data }: any) => {
      if (this.refreshTokens.some((t) => t.tokenHash === data.tokenHash)) {
        throw p2002('tokenHash');
      }
      const row = {
        id: randomUUID(),
        revokedAt: null,
        createdAt: new Date(),
        ...data,
      };
      this.refreshTokens.push(row);
      return row;
    },
    findUnique: async ({ where }: any) =>
      this.refreshTokens.find((t) => t.tokenHash === where.tokenHash) ?? null,
    update: async ({ where, data }: any) => {
      const row = this.refreshTokens.find((t) => t.id === where.id);
      if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const row of this.refreshTokens) {
        if (matches(row, where)) {
          Object.assign(row, data);
          count++;
        }
      }
      return { count };
    },
  };

  readonly orderAudit = {
    create: async ({ data }: any) => {
      if (
        data.idempotencyKey != null &&
        this.orderAudits.some(
          (a) => a.userId === data.userId && a.idempotencyKey === data.idempotencyKey,
        )
      ) {
        throw p2002('userId, idempotencyKey');
      }
      const row = {
        id: randomUUID(),
        createdAt: new Date(),
        ...data,
      };
      this.orderAudits.push(row);
      return row;
    },
    findUnique: async ({ where }: any) => {
      const key = where.userId_idempotencyKey;
      return (
        this.orderAudits.find(
          (a) => a.userId === key.userId && a.idempotencyKey === key.idempotencyKey,
        ) ?? null
      );
    },
    findMany: async ({ where }: any = {}) =>
      this.orderAudits.filter((a) => matches(a, where)),
  };

  // Prisma lifecycle no-ops.
  async $connect(): Promise<void> {}
  async $disconnect(): Promise<void> {}
  async onModuleInit(): Promise<void> {}
  async onModuleDestroy(): Promise<void> {}

  /** Test helper: wipe all tables. */
  reset(): void {
    this.users.length = 0;
    this.credentials.length = 0;
    this.refreshTokens.length = 0;
    this.orderAudits.length = 0;
  }

  /** Test helper: flip the kill switch for a user. */
  setTradingDisabled(userId: string, disabled: boolean): void {
    const user = this.users.find((u) => u.id === userId);
    if (user) user.tradingDisabled = disabled;
  }
}
