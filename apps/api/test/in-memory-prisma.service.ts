import { randomUUID } from 'node:crypto';

/**
 * In-memory stand-in for PrismaService, used by unit and e2e tests so the
 * suite runs without Postgres. It mirrors exactly the delegate surface the
 * app uses (documented on PrismaService) and emulates:
 *   - @default(uuid()) / @default(now()) / @updatedAt
 *   - unique constraints on user.email, refreshToken.tokenHash,
 *     webullCredential.(userId, environment),
 *     brokerCredential.(userId, provider, environment),
 *     orderAudit.(userId, idempotencyKey),
 *     tradeOrderExecution.(orderId, cumulative) and
 *     pushDelivery.(userId, key, deviceToken), userEvent.(userId, sequence),
 *     webhookInbox.(provider, webhookId), chartOrder.(ocoGroupId, kind),
 *     discordDelivery.(userId, key), legalAcceptance.(userId, document, version) —
 *     the ones whose columns are all NOT NULL,
 *     so it has no nullable-unique semantics to emulate
 *     (violations throw a P2002-coded error like the real client)
 *   - nullable unique column semantics for orderAudit.idempotencyKey and
 *     tradeOrderExecution.cumulative
 *     (multiple NULL keys never conflict, as in Postgres)
 *
 * It is injected via `overrideProvider(PrismaService).useValue(fake)`, so it
 * intentionally does not extend PrismaClient.
 */

function p2002(target: string): Error {
  return Object.assign(new Error(`Unique constraint failed on the fields: (${target})`), {
    code: 'P2002',
  });
}

/**
 * Prisma treats an `undefined` field in an update as "leave this column alone",
 * whereas Object.assign would write the undefined over the stored value. Callers
 * rely on that distinction (see OrdersService.record, where only the placement
 * path knows the underlying price), so strip undefined before assigning.
 */
function definedOnly(data: any): any {
  return Object.fromEntries(Object.entries(data ?? {}).filter(([, v]) => v !== undefined));
}

function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, value]) => {
    // Boolean combinators, so callers can express the same filters they send to
    // Prisma (chart-order listing and the watcher's lease both need them).
    if (key === 'OR') return (value as any[]).some((clause) => matches(row, clause));
    if (key === 'AND') return (value as any[]).every((clause) => matches(row, clause));
    if (key === 'NOT') return !matches(row, value);
    if (value === null) return row[key] === null || row[key] === undefined;
    // Dates are objects, so without this they fall into the operator branch
    // below where every comparison is `undefined` and the row matches by
    // accident — a `where` that should select one row would select all of them.
    if (value instanceof Date) {
      return row[key] instanceof Date && row[key].getTime() === value.getTime();
    }
    if (typeof value === 'object' && value !== null) {
      const actual = row[key];
      const operator = value as Record<string, any>;
      if (operator.lt !== undefined && !(actual < operator.lt)) return false;
      if (operator.lte !== undefined && !(actual <= operator.lte)) return false;
      if (operator.gt !== undefined && !(actual > operator.gt)) return false;
      if (operator.gte !== undefined && !(actual >= operator.gte)) return false;
      if (operator.equals !== undefined && actual !== operator.equals) return false;
      if (operator.in !== undefined && !operator.in.includes(actual)) return false;
      if (operator.has !== undefined && !(Array.isArray(actual) && actual.includes(operator.has))) {
        return false;
      }
      // Fail loudly on anything this double does not implement. Returning true
      // means an unsupported operator silently matches EVERY row, so a query
      // that should select one selects all — tests then pass on behaviour the
      // database would never produce.
      const supported = ['lt', 'lte', 'gt', 'gte', 'equals', 'in', 'has'];
      const unsupported = Object.keys(operator).filter((k) => !supported.includes(k));
      if (unsupported.length > 0) {
        throw new Error(
          `in-memory prisma: unsupported where operator(s) ${unsupported.join(', ')} on "${key}"`,
        );
      }
      return true;
    }
    return row[key] === value;
  });
}

export class InMemoryPrismaService {
  private transactionTail: Promise<void> = Promise.resolve();
  readonly users: any[] = [];
  readonly credentials: any[] = [];
  readonly refreshTokens: any[] = [];
  readonly orderAudits: any[] = [];
  readonly tradeOrders: any[] = [];
  readonly tradeOrderExecutions: any[] = [];
  readonly chartOrders: any[] = [];
  readonly bracketGroups: any[] = [];
  readonly optionsAnalyticsSnapshots: any[] = [];
  readonly scheduledJobLeases: any[] = [];
  readonly brokerCredentials: any[] = [];
  readonly brokerApiTokens: any[] = [];
  readonly brokerConnections: any[] = [];
  readonly deviceTokens: any[] = [];
  readonly pushDeliveries: any[] = [];
  readonly webhookInboxRows: any[] = [];
  readonly userEvents: any[] = [];
  readonly discordSettingsRows: any[] = [];
  readonly discordDeliveries: any[] = [];
  readonly legalAcceptances: any[] = [];

  private tradeOrderConflict(data: any, except?: any): boolean {
    return this.tradeOrders.some((row) => {
      if (row === except || row.userId !== data.userId || row.provider !== data.provider)
        return false;
      if (row.environment !== data.environment || row.accountId !== data.accountId) return false;
      return (
        (data.brokerOrderId != null && row.brokerOrderId === data.brokerOrderId) ||
        (data.clientOrderId != null && row.clientOrderId === data.clientOrderId)
      );
    });
  }

  readonly user = {
    findUnique: async ({ where }: any) => {
      if (where.email !== undefined) {
        return this.users.find((u) => u.email === where.email) ?? null;
      }
      return this.users.find((u) => u.id === where.id) ?? null;
    },
    findMany: async ({ where }: any = {}) => this.users.filter((u) => matches(u, where)),
    create: async ({ data }: any) => {
      if (this.users.some((u) => u.email === data.email)) throw p2002('email');
      const now = new Date();
      const row = {
        id: randomUUID(),
        tradingDisabled: false,
        tradingMode: 'live',
        tradingProvider: 'webull',
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
    delete: async ({ where }: any) => {
      const index = this.users.findIndex((u) => u.id === where.id);
      if (index === -1) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      const [row] = this.users.splice(index, 1);
      const owned = (value: any) => value.userId === row.id;
      const orderIds = new Set(this.tradeOrders.filter(owned).map((order) => order.id));
      for (const table of [
        this.credentials,
        this.refreshTokens,
        this.orderAudits,
        this.tradeOrders,
        this.chartOrders,
        this.bracketGroups,
        this.brokerCredentials,
        this.brokerApiTokens,
        this.brokerConnections,
        this.deviceTokens,
        this.pushDeliveries,
        this.webhookInboxRows,
        this.userEvents,
        this.discordSettingsRows,
        this.discordDeliveries,
        this.legalAcceptances,
      ]) {
        for (let i = table.length - 1; i >= 0; i -= 1) if (owned(table[i])) table.splice(i, 1);
      }
      for (let i = this.tradeOrderExecutions.length - 1; i >= 0; i -= 1) {
        if (orderIds.has(this.tradeOrderExecutions[i].orderId))
          this.tradeOrderExecutions.splice(i, 1);
      }
      return row;
    },
  };

  readonly webullCredential = {
    findUnique: async ({ where }: any) => {
      const key = where.userId_environment ?? {
        userId: where.userId,
        environment: 'live',
      };
      return (
        this.credentials.find(
          (c) => c.userId === key.userId && c.environment === key.environment,
        ) ?? null
      );
    },
    upsert: async ({ where, create, update }: any) => {
      const key = where.userId_environment ?? {
        userId: where.userId,
        environment: 'live',
      };
      const existing = this.credentials.find(
        (c) => c.userId === key.userId && c.environment === key.environment,
      );
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
      const key = where.userId_environment ?? {
        userId: where.userId,
        environment: 'live',
      };
      const idx = this.credentials.findIndex(
        (c) => c.userId === key.userId && c.environment === key.environment,
      );
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
    update: async ({ where, data }: any) => {
      const row = this.orderAudits.find((a) => a.id === where.id);
      if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      Object.assign(row, data);
      return row;
    },
    delete: async ({ where }: any) => {
      const idx = this.orderAudits.findIndex((a) => a.id === where.id);
      if (idx === -1) {
        throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      }
      const [row] = this.orderAudits.splice(idx, 1);
      return row;
    },
    findMany: async ({ where }: any = {}) => this.orderAudits.filter((a) => matches(a, where)),
  };

  readonly tradeOrder = {
    findUnique: async ({ where }: any) => {
      if (where.id !== undefined) return this.tradeOrders.find((o) => o.id === where.id) ?? null;
      const broker = where.userId_provider_environment_accountId_brokerOrderId;
      if (broker) {
        return (
          this.tradeOrders.find(
            (o) =>
              o.userId === broker.userId &&
              o.provider === broker.provider &&
              o.environment === broker.environment &&
              o.accountId === broker.accountId &&
              o.brokerOrderId === broker.brokerOrderId,
          ) ?? null
        );
      }
      const client = where.userId_provider_environment_accountId_clientOrderId;
      if (client) {
        return (
          this.tradeOrders.find(
            (o) =>
              o.userId === client.userId &&
              o.provider === client.provider &&
              o.environment === client.environment &&
              o.accountId === client.accountId &&
              o.clientOrderId === client.clientOrderId,
          ) ?? null
        );
      }
      return null;
    },
    findFirst: async ({ where, orderBy }: any = {}) => {
      const rows = this.tradeOrders.filter((o) => matches(o, where));
      if (orderBy?.placedAt === 'asc') {
        rows.sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());
      } else if (orderBy?.placedAt === 'desc') {
        rows.sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime());
      }
      return rows[0] ?? null;
    },
    create: async ({ data }: any) => {
      const normalized = {
        provider: 'webull',
        accountId: 'default',
        brokerOrderId: null,
        clientOrderId: null,
        ...data,
      };
      if (this.tradeOrderConflict(normalized)) throw p2002('scoped external order id');
      const row = {
        // Prisma's primary key is always an internal UUID. Reusing an external
        // broker/client id here hid tenant-scoping bugs and made tests exercise
        // a schema production never has.
        id: normalized.id ?? randomUUID(),
        updatedAt: new Date(),
        ...normalized,
      };
      this.tradeOrders.push(row);
      return row;
    },
    upsert: async ({ where, create, update }: any) => {
      const existing =
        (where.id !== undefined ? this.tradeOrders.find((o) => o.id === where.id) : undefined) ??
        (await this.tradeOrder.findUnique({ where }));
      if (existing) {
        const next = { ...existing, ...definedOnly(update) };
        if (this.tradeOrderConflict(next, existing)) throw p2002('scoped external order id');
        Object.assign(existing, definedOnly(update), { updatedAt: new Date() });
        return existing;
      }
      return this.tradeOrder.create({ data: create });
    },
    findMany: async ({ where, orderBy }: any = {}) => {
      const rows = this.tradeOrders.filter((o) => matches(o, where));
      if (orderBy?.placedAt === 'asc') {
        rows.sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());
      } else if (orderBy?.placedAt === 'desc') {
        rows.sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime());
      }
      return rows;
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const row of this.tradeOrders) {
        if (matches(row, where)) {
          const next = { ...row, ...definedOnly(data) };
          if (this.tradeOrderConflict(next, row)) throw p2002('scoped external order id');
          Object.assign(row, definedOnly(data), { updatedAt: new Date() });
          count += 1;
        }
      }
      return { count };
    },
  };

  readonly tradeOrderExecution = {
    create: async ({ data }: any) => {
      if (
        data.cumulative != null &&
        this.tradeOrderExecutions.some(
          (e) => e.orderId === data.orderId && e.cumulative === data.cumulative,
        )
      ) {
        throw p2002('orderId, cumulative');
      }
      // Every nullable column defaults to null, not undefined: Prisma returns
      // null for an unwritten column, and a reader distinguishing the row
      // shapes on `x === null` would otherwise pass here and misfire live.
      const row = {
        id: randomUUID(),
        createdAt: new Date(),
        cumulative: null,
        avgPrice: null,
        quantity: null,
        price: null,
        ...data,
      };
      this.tradeOrderExecutions.push(row);
      return row;
    },
    // No orderBy: the replay sorts executions itself, so callers must not
    // depend on database ordering here (and the real schema promises none).
    findMany: async ({ where }: any = {}) =>
      this.tradeOrderExecutions.filter((e) => matches(e, where)),
  };

  readonly optionsAnalyticsSnapshotRecord = {
    create: async ({ data }: any) => {
      if (
        this.optionsAnalyticsSnapshots.some(
          (row) =>
            row.symbol === data.symbol &&
            row.expiration === data.expiration &&
            row.bucket.getTime() === data.bucket.getTime() &&
            row.calculationVersion === data.calculationVersion &&
            row.resolutionMinutes === data.resolutionMinutes,
        )
      ) {
        throw p2002('symbol, expiration, bucket, calculationVersion, resolutionMinutes');
      }
      const row = {
        id: randomUUID(),
        createdAt: new Date(),
        ...data,
      };
      this.optionsAnalyticsSnapshots.push(row);
      return row;
    },
    findMany: async ({ where, orderBy, take }: any = {}) => {
      const rows = this.optionsAnalyticsSnapshots.filter((row) => matches(row, where));
      if (orderBy?.bucket === 'asc') {
        rows.sort((a, b) => a.bucket.getTime() - b.bucket.getTime());
      } else if (orderBy?.bucket === 'desc') {
        rows.sort((a, b) => b.bucket.getTime() - a.bucket.getTime());
      }
      return take === undefined ? rows : rows.slice(0, take);
    },
    deleteMany: async ({ where }: any = {}) => {
      let count = 0;
      for (let index = this.optionsAnalyticsSnapshots.length - 1; index >= 0; index--) {
        if (matches(this.optionsAnalyticsSnapshots[index], where)) {
          this.optionsAnalyticsSnapshots.splice(index, 1);
          count += 1;
        }
      }
      return { count };
    },
  };

  readonly chartOrder = {
    create: async ({ data }: any) => {
      if (
        data.ocoGroupId != null &&
        this.chartOrders.some(
          (order) => order.ocoGroupId === data.ocoGroupId && order.kind === data.kind,
        )
      ) {
        throw p2002('ocoGroupId, kind');
      }
      const now = new Date();
      const row = {
        id: `co-${this.chartOrders.length + 1}`,
        ocoGroupId: null,
        status: 'working',
        triggeredAt: null,
        brokerOrderId: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      this.chartOrders.push(row);
      return row;
    },
    findUnique: async ({ where }: any) => this.chartOrders.find((o) => o.id === where.id) ?? null,
    findFirst: async ({ where }: any) => this.chartOrders.find((o) => matches(o, where)) ?? null,
    findMany: async ({ where, orderBy }: any = {}) => {
      const rows = this.chartOrders.filter((o) => matches(o, where));
      if (orderBy?.createdAt === 'asc') {
        rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      } else if (orderBy?.createdAt === 'desc') {
        rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      return rows;
    },
    count: async ({ where }: any = {}) => this.chartOrders.filter((o) => matches(o, where)).length,
    update: async ({ where, data }: any) => {
      const row = this.chartOrders.find((o) => o.id === where.id);
      if (!row) throw new Error(`chartOrder ${where.id} not found`);
      Object.assign(row, definedOnly(data), { updatedAt: new Date() });
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const row of this.chartOrders) {
        if (matches(row, where)) {
          Object.assign(row, definedOnly(data), { updatedAt: new Date() });
          count += 1;
        }
      }
      return { count };
    },
  };

  readonly bracketGroup = {
    create: async ({ data }: any) => {
      if (this.bracketGroups.some((group) => group.id === data.id)) throw p2002('id');
      const now = new Date();
      const row = {
        status: 'working',
        fireLegId: null,
        leaseOwnerId: null,
        leaseExpiresAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      this.bracketGroups.push(row);
      return row;
    },
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { id: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const existing = this.bracketGroups.find((group) => group.id === where.id);
      if (existing) {
        Object.assign(existing, definedOnly(update));
        return existing;
      }
      return this.bracketGroup.create({ data: create });
    },
    findUnique: async ({ where }: any) =>
      this.bracketGroups.find((group) => group.id === where.id) ?? null,
    findFirst: async ({ where }: any) =>
      this.bracketGroups.find((group) => matches(group, where)) ?? null,
    findMany: async ({ where, orderBy, take }: any = {}) => {
      const rows = this.bracketGroups.filter((group) => matches(group, where));
      if (orderBy?.createdAt === 'asc') {
        rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      }
      return take === undefined ? rows : rows.slice(0, take);
    },
    update: async ({ where, data }: any) => {
      const row = this.bracketGroups.find((group) => group.id === where.id);
      if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      Object.assign(row, definedOnly(data), { updatedAt: new Date() });
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const row of this.bracketGroups) {
        if (!matches(row, where)) continue;
        Object.assign(row, definedOnly(data), { updatedAt: new Date() });
        count += 1;
      }
      return { count };
    },
  };

  readonly scheduledJobLease = {
    create: async ({ data }: any) => {
      if (this.scheduledJobLeases.some((row) => row.name === data.name)) {
        throw p2002('name');
      }
      const row = { updatedAt: new Date(), ...data };
      this.scheduledJobLeases.push(row);
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const row of this.scheduledJobLeases) {
        if (matches(row, where)) {
          Object.assign(row, data, { updatedAt: new Date() });
          count += 1;
        }
      }
      return { count };
    },
  };

  readonly brokerCredential = {
    findUnique: async ({ where }: any) => {
      const key = where.userId_provider_environment ?? {
        userId: where.userId,
        provider: where.provider ?? 'webull',
        environment: 'live',
      };
      return (
        this.brokerCredentials.find(
          (c) =>
            c.userId === key.userId &&
            c.provider === key.provider &&
            c.environment === key.environment,
        ) ?? null
      );
    },
    findMany: async ({ where }: any = {}) =>
      this.brokerCredentials.filter((c) => matches(c, where)),
    upsert: async ({ where, create, update }: any) => {
      const key = where.userId_provider_environment ?? {
        userId: where.userId,
        provider: where.provider ?? 'webull',
        environment: 'live',
      };
      const existing = this.brokerCredentials.find(
        (c) =>
          c.userId === key.userId &&
          c.provider === key.provider &&
          c.environment === key.environment,
      );
      if (existing) {
        Object.assign(existing, update, { updatedAt: new Date() });
        return existing;
      }
      const now = new Date();
      const row = { id: randomUUID(), createdAt: now, updatedAt: now, ...create };
      this.brokerCredentials.push(row);
      return row;
    },
    delete: async ({ where }: any) => {
      const key = where.userId_provider_environment ?? {
        userId: where.userId,
        provider: where.provider ?? 'webull',
        environment: 'live',
      };
      const idx = this.brokerCredentials.findIndex(
        (c) =>
          c.userId === key.userId &&
          c.provider === key.provider &&
          c.environment === key.environment,
      );
      if (idx === -1) {
        throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      }
      const [row] = this.brokerCredentials.splice(idx, 1);
      return row;
    },
  };

  readonly brokerApiToken = {
    findUnique: async ({ where }: any) => {
      const key = where.userId_provider_environment ?? {
        userId: where.userId,
        provider: where.provider ?? 'webull',
        environment: 'live',
      };
      return (
        this.brokerApiTokens.find(
          (t) =>
            t.userId === key.userId &&
            t.provider === key.provider &&
            t.environment === key.environment,
        ) ?? null
      );
    },
    upsert: async ({ where, create, update }: any) => {
      const key = where.userId_provider_environment ?? {
        userId: where.userId,
        provider: where.provider ?? 'webull',
        environment: 'live',
      };
      const existing = this.brokerApiTokens.find(
        (t) =>
          t.userId === key.userId &&
          t.provider === key.provider &&
          t.environment === key.environment,
      );
      if (existing) {
        Object.assign(existing, update, { updatedAt: new Date() });
        return existing;
      }
      const now = new Date();
      const row = { id: randomUUID(), createdAt: now, updatedAt: now, ...create };
      this.brokerApiTokens.push(row);
      return row;
    },
    deleteMany: async ({ where }: any) => {
      let count = 0;
      for (let i = this.brokerApiTokens.length - 1; i >= 0; i--) {
        if (matches(this.brokerApiTokens[i], where)) {
          this.brokerApiTokens.splice(i, 1);
          count += 1;
        }
      }
      return { count };
    },
  };

  readonly brokerConnection = {
    findUnique: async ({ where }: any) => {
      const key = where.userId_provider_environment ??
        where.userId_provider ?? { userId: where.userId, provider: where.provider };
      return (
        this.brokerConnections.find(
          (c) =>
            c.userId === key.userId &&
            c.provider === key.provider &&
            (key.environment === undefined || c.environment === key.environment),
        ) ?? null
      );
    },
    findMany: async ({ where }: any = {}) =>
      this.brokerConnections.filter((c) => matches(c, where)),
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const row of this.brokerConnections) {
        if (!matches(row, where)) continue;
        if (data.accountIds?.push !== undefined) {
          row.accountIds = [...row.accountIds, data.accountIds.push];
        }
        if (data.status !== undefined) row.status = data.status;
        row.updatedAt = new Date();
        count += 1;
      }
      return { count };
    },
    upsert: async ({ where, create, update }: any) => {
      const key = where.userId_provider_environment ??
        where.userId_provider ?? { userId: where.userId, provider: where.provider };
      const existing = this.brokerConnections.find(
        (c) =>
          c.userId === key.userId &&
          c.provider === key.provider &&
          (key.environment === undefined || c.environment === key.environment),
      );
      if (existing) {
        Object.assign(existing, update, { updatedAt: new Date() });
        return existing;
      }
      const now = new Date();
      const row = { id: randomUUID(), createdAt: now, updatedAt: now, ...create };
      this.brokerConnections.push(row);
      return row;
    },
    delete: async ({ where }: any) => {
      const key = where.userId_provider_environment ??
        where.userId_provider ?? { userId: where.userId, provider: where.provider };
      const idx = this.brokerConnections.findIndex(
        (c) =>
          c.userId === key.userId &&
          c.provider === key.provider &&
          (key.environment === undefined || c.environment === key.environment),
      );
      if (idx === -1) {
        throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      }
      const [row] = this.brokerConnections.splice(idx, 1);
      return row;
    },
    deleteMany: async ({ where }: any) => {
      let count = 0;
      for (let i = this.brokerConnections.length - 1; i >= 0; i--) {
        if (matches(this.brokerConnections[i], where)) {
          this.brokerConnections.splice(i, 1);
          count += 1;
        }
      }
      return { count };
    },
  };

  readonly deviceToken = {
    findMany: async ({ where, orderBy }: any = {}) => {
      const rows = this.deviceTokens.filter((token) => matches(token, where));
      if (orderBy?.updatedAt === 'desc') {
        rows.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
      }
      return rows;
    },
    upsert: async ({ where, create, update }: any) => {
      const existing = this.deviceTokens.find((t) => t.token === where.token);
      if (existing) {
        Object.assign(existing, definedOnly(update), { updatedAt: new Date() });
        return existing;
      }
      const now = new Date();
      const row = { id: randomUUID(), createdAt: now, updatedAt: now, ...create };
      this.deviceTokens.push(row);
      return row;
    },
    deleteMany: async ({ where }: any = {}) => {
      const keep = this.deviceTokens.filter((t) => !matches(t, where));
      const count = this.deviceTokens.length - keep.length;
      this.deviceTokens.length = 0;
      this.deviceTokens.push(...keep);
      return { count };
    },
  };

  readonly pushDelivery = {
    create: async ({ data }: any) => {
      if (
        this.pushDeliveries.some(
          (d) =>
            d.userId === data.userId && d.key === data.key && d.deviceToken === data.deviceToken,
        )
      ) {
        throw p2002('userId, key, deviceToken');
      }
      const now = new Date();
      const row = {
        id: randomUUID(),
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        leaseOwnerId: null,
        leaseExpiresAt: null,
        lastError: null,
        deliveredAt: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      this.pushDeliveries.push(row);
      return row;
    },
    findUnique: async ({ where }: any) =>
      this.pushDeliveries.find((delivery) => delivery.id === where.id) ?? null,
    findFirst: async ({ where, orderBy }: any = {}) => {
      const rows = this.pushDeliveries.filter((delivery) => matches(delivery, where));
      if (orderBy?.createdAt === 'asc') {
        rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      }
      return rows[0] ?? null;
    },
    findMany: async ({ where, orderBy, take }: any = {}) => {
      const rows = this.pushDeliveries.filter((delivery) => matches(delivery, where));
      if (orderBy?.createdAt === 'asc') {
        rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      }
      return take === undefined ? rows : rows.slice(0, take);
    },
    update: async ({ where, data }: any) => {
      const row = this.pushDeliveries.find((delivery) => delivery.id === where.id);
      if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      Object.assign(row, definedOnly(data), { updatedAt: new Date() });
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const row of this.pushDeliveries) {
        if (!matches(row, where)) continue;
        Object.assign(row, definedOnly(data), { updatedAt: new Date() });
        count += 1;
      }
      return { count };
    },
    deleteMany: async ({ where }: any = {}) => {
      const keep = this.pushDeliveries.filter((d) => !matches(d, where));
      const count = this.pushDeliveries.length - keep.length;
      this.pushDeliveries.length = 0;
      this.pushDeliveries.push(...keep);
      return { count };
    },
  };

  readonly webhookInbox = {
    create: async ({ data }: any) => {
      if (
        this.webhookInboxRows.some(
          (row) => row.provider === data.provider && row.webhookId === data.webhookId,
        )
      ) {
        throw p2002('provider, webhookId');
      }
      const now = new Date();
      const row = {
        id: randomUUID(),
        accountId: null,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        leaseOwnerId: null,
        leaseExpiresAt: null,
        lastError: null,
        failureStage: null,
        processedAt: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      this.webhookInboxRows.push(row);
      return row;
    },
    findUnique: async ({ where }: any) => {
      if (where.id !== undefined)
        return this.webhookInboxRows.find((row) => row.id === where.id) ?? null;
      const key = where.provider_webhookId;
      return (
        this.webhookInboxRows.find(
          (row) => row.provider === key.provider && row.webhookId === key.webhookId,
        ) ?? null
      );
    },
    findFirst: async ({ where, orderBy }: any = {}) => {
      const rows = this.webhookInboxRows.filter((row) => matches(row, where));
      if (orderBy?.createdAt === 'asc') {
        rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      }
      return rows[0] ?? null;
    },
    findMany: async ({ where, orderBy, take }: any = {}) => {
      const rows = this.webhookInboxRows.filter((row) => matches(row, where));
      if (orderBy?.createdAt === 'asc') {
        rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      }
      return take === undefined ? rows : rows.slice(0, take);
    },
    update: async ({ where, data }: any) => {
      const row = this.webhookInboxRows.find((entry) => entry.id === where.id);
      if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      Object.assign(row, definedOnly(data), { updatedAt: new Date() });
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const row of this.webhookInboxRows) {
        if (!matches(row, where)) continue;
        Object.assign(row, definedOnly(data), { updatedAt: new Date() });
        count += 1;
      }
      return { count };
    },
  };

  readonly userEvent = {
    create: async ({ data }: any) => {
      if (
        this.userEvents.some(
          (event) => event.userId === data.userId && event.sequence === data.sequence,
        )
      ) {
        throw p2002('userId, sequence');
      }
      if (
        data.dedupeKey != null &&
        this.userEvents.some(
          (event) => event.userId === data.userId && event.dedupeKey === data.dedupeKey,
        )
      ) {
        throw p2002('userId, dedupeKey');
      }
      let ordinal = 1n;
      for (const event of this.userEvents)
        if (event.ordinal >= ordinal) ordinal = event.ordinal + 1n;
      const row = { ordinal, id: randomUUID(), createdAt: new Date(), ...data };
      this.userEvents.push(row);
      return row;
    },
    findUnique: async ({ where }: any) => {
      const key = where.userId_dedupeKey;
      return (
        this.userEvents.find(
          (event) => event.userId === key.userId && event.dedupeKey === key.dedupeKey,
        ) ?? null
      );
    },
    findFirst: async ({ where, orderBy }: any = {}) => {
      const rows = this.userEvents.filter((event) => matches(event, where));
      if (orderBy?.ordinal === 'desc') rows.sort((a, b) => (a.ordinal < b.ordinal ? 1 : -1));
      if (orderBy?.sequence === 'desc') rows.sort((a, b) => b.sequence - a.sequence);
      return rows[0] ?? null;
    },
    findMany: async ({ where, orderBy, take }: any = {}) => {
      const rows = this.userEvents.filter((event) => matches(event, where));
      if (orderBy?.ordinal === 'asc') rows.sort((a, b) => (a.ordinal > b.ordinal ? 1 : -1));
      if (orderBy?.sequence === 'asc') rows.sort((a, b) => a.sequence - b.sequence);
      return take === undefined ? rows : rows.slice(0, take);
    },
  };

  readonly discordNotificationSettings = {
    findUnique: async ({ where }: any) =>
      this.discordSettingsRows.find((row) => row.userId === where.userId) ?? null,
    upsert: async ({ where, create, update }: any) => {
      const existing = this.discordSettingsRows.find((row) => row.userId === where.userId);
      if (existing) {
        Object.assign(existing, definedOnly(update), { updatedAt: new Date() });
        return existing;
      }
      const now = new Date();
      const row = {
        encWebhookUrl: null,
        enabled: false,
        includePnl: false,
        createdAt: now,
        updatedAt: now,
        ...create,
      };
      this.discordSettingsRows.push(row);
      return row;
    },
  };

  readonly discordDelivery = {
    create: async ({ data }: any) => {
      if (
        this.discordDeliveries.some((row) => row.userId === data.userId && row.key === data.key)
      ) {
        throw p2002('userId, key');
      }
      const now = new Date();
      const row = {
        id: randomUUID(),
        attempts: 0,
        lastError: null,
        deliveredAt: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      this.discordDeliveries.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = this.discordDeliveries.find((delivery) => delivery.id === where.id);
      if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      Object.assign(row, definedOnly(data), { updatedAt: new Date() });
      return row;
    },
    deleteMany: async ({ where }: any = {}) => {
      const keep = this.discordDeliveries.filter((row) => !matches(row, where));
      const count = this.discordDeliveries.length - keep.length;
      this.discordDeliveries.length = 0;
      this.discordDeliveries.push(...keep);
      return { count };
    },
  };

  readonly legalAcceptance = {
    create: async ({ data }: any) => {
      if (
        this.legalAcceptances.some(
          (row) =>
            row.userId === data.userId &&
            row.document === data.document &&
            row.version === data.version,
        )
      ) {
        throw p2002('userId, document, version');
      }
      const row = { id: randomUUID(), acceptedAt: new Date(), ...data };
      this.legalAcceptances.push(row);
      return row;
    },
    findMany: async ({ where }: any = {}) =>
      this.legalAcceptances.filter((row) => matches(row, where)),
  };

  /** Serial transaction double with rollback. Serializing mirrors the row-lock
   * behavior these bracket transactions rely on and keeps concurrent tests
   * deterministic; structuredClone preserves Date and BigInt values. */
  async $transaction<T>(operation: (database: this) => Promise<T>): Promise<T> {
    const run = this.transactionTail.then(async () => {
      const tables = this.mutableTables();
      const snapshots = tables.map((table) => structuredClone(table));
      try {
        return await operation(this);
      } catch (error) {
        for (let index = 0; index < tables.length; index += 1) {
          const table = tables[index];
          const snapshot = snapshots[index];
          if (table && snapshot) table.splice(0, table.length, ...snapshot);
        }
        throw error;
      }
    });
    this.transactionTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private mutableTables(): Array<Array<Record<string, unknown>>> {
    return [
      this.users,
      this.credentials,
      this.refreshTokens,
      this.orderAudits,
      this.tradeOrders,
      this.tradeOrderExecutions,
      this.chartOrders,
      this.bracketGroups,
      this.optionsAnalyticsSnapshots,
      this.scheduledJobLeases,
      this.brokerCredentials,
      this.brokerApiTokens,
      this.brokerConnections,
      this.deviceTokens,
      this.pushDeliveries,
      this.webhookInboxRows,
      this.userEvents,
      this.discordSettingsRows,
      this.discordDeliveries,
      this.legalAcceptances,
    ];
  }

  // Prisma lifecycle no-ops.
  async $connect(): Promise<void> {}
  async $disconnect(): Promise<void> {}
  async onModuleInit(): Promise<void> {}
  async onModuleDestroy(): Promise<void> {}

  /** Marks the current legal versions accepted for tests whose subject is
   * trading behavior rather than the mandatory legal gate. */
  acceptCurrentTradingLegal(userId: string): void {
    for (const document of ['terms', 'risk']) {
      if (
        this.legalAcceptances.some(
          (row) =>
            row.userId === userId && row.document === document && row.version === '2026-08-05',
        )
      ) {
        continue;
      }
      this.legalAcceptances.push({
        id: randomUUID(),
        userId,
        document,
        version: '2026-08-05',
        acceptedAt: new Date(),
      });
    }
  }

  /** Test helper: wipe all tables. */
  reset(): void {
    this.users.length = 0;
    this.credentials.length = 0;
    this.refreshTokens.length = 0;
    this.orderAudits.length = 0;
    this.tradeOrders.length = 0;
    this.tradeOrderExecutions.length = 0;
    this.chartOrders.length = 0;
    this.bracketGroups.length = 0;
    this.optionsAnalyticsSnapshots.length = 0;
    this.scheduledJobLeases.length = 0;
    this.brokerCredentials.length = 0;
    this.brokerApiTokens.length = 0;
    this.brokerConnections.length = 0;
    this.deviceTokens.length = 0;
    this.pushDeliveries.length = 0;
    this.webhookInboxRows.length = 0;
    this.userEvents.length = 0;
    this.discordSettingsRows.length = 0;
    this.discordDeliveries.length = 0;
    this.legalAcceptances.length = 0;
  }

  /** Test helper: flip the kill switch for a user. */
  setTradingDisabled(userId: string, disabled: boolean): void {
    const user = this.users.find((u) => u.id === userId);
    if (user) user.tradingDisabled = disabled;
  }
}
