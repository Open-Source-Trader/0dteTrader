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
    findMany: async ({ where }: any = {}) =>
      this.orderAudits.filter((a) => matches(a, where)),
  };
