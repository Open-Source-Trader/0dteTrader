import { MANAGED_SECRET_NAMES, bootstrapSecrets, type SecretStore } from './secret-bootstrap';

/**
 * In-memory stand-in for the runtime_secrets table. `createMany` with
 * skipDuplicates mirrors Postgres ON CONFLICT DO NOTHING: an existing row is
 * never overwritten, so two racing writers converge on the first value.
 */
function inMemoryStore(): { store: SecretStore; rows: Map<string, string>; writes: () => number } {
  const rows = new Map<string, string>();
  let writeCalls = 0;
  const store: SecretStore = {
    runtimeSecret: {
      findUnique: async ({ where }) => {
        const value = rows.get(where.name);
        return value === undefined ? null : { name: where.name, value };
      },
      createMany: async ({ data }) => {
        writeCalls += 1;
        let count = 0;
        for (const row of data) {
          if (!rows.has(row.name)) {
            rows.set(row.name, row.value);
            count += 1;
          }
        }
        return { count };
      },
    },
  };
  return { store, rows, writes: () => writeCalls };
}

describe('bootstrapSecrets', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of MANAGED_SECRET_NAMES) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of MANAGED_SECRET_NAMES) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  it('leaves an already-set env var alone and never writes it to the database', async () => {
    process.env.JWT_ACCESS_SECRET = 'from-env';
    const { store, rows } = inMemoryStore();

    await bootstrapSecrets(store);

    expect(process.env.JWT_ACCESS_SECRET).toBe('from-env');
    expect(rows.has('JWT_ACCESS_SECRET')).toBe(false);
  });

  it('loads an existing row into process.env when the env var is absent', async () => {
    const { store, rows } = inMemoryStore();
    rows.set('JWT_REFRESH_SECRET', 'persisted-value');

    await bootstrapSecrets(store);

    expect(process.env.JWT_REFRESH_SECRET).toBe('persisted-value');
  });

  it('generates, persists, and assigns each missing secret', async () => {
    const { store, rows } = inMemoryStore();

    const generated = await bootstrapSecrets(store);

    for (const name of MANAGED_SECRET_NAMES) {
      expect(process.env[name]).toBeTruthy();
      expect(rows.get(name)).toBe(process.env[name]);
    }
    expect(generated.sort()).toEqual([...MANAGED_SECRET_NAMES].sort());
  });

  it('generates a CRED_ENCRYPTION_KEY that decodes to exactly 32 bytes', async () => {
    const { store } = inMemoryStore();

    await bootstrapSecrets(store);

    const key = process.env.CRED_ENCRYPTION_KEY as string;
    expect(Buffer.from(key, 'base64').length).toBe(32);
  });

  it('converges on the first writer’s value when two boots race', async () => {
    // A racing replica wins every insert between our read and our write:
    // findUnique sees nothing, but by createMany time the row already exists.
    const rows = new Map<string, string>();
    const store: SecretStore = {
      runtimeSecret: {
        findUnique: async ({ where }) => {
          const value = rows.get(where.name);
          return value === undefined ? null : { name: where.name, value };
        },
        createMany: async ({ data }) => {
          for (const row of data) {
            if (!rows.has(row.name)) rows.set(row.name, `rival-${row.name}`);
          }
          return { count: 0 };
        },
      },
    };

    await bootstrapSecrets(store);

    for (const name of MANAGED_SECRET_NAMES) {
      expect(process.env[name]).toBe(`rival-${name}`);
    }
  });

  it('is idempotent: a restart reloads the same persisted values', async () => {
    const { store } = inMemoryStore();

    await bootstrapSecrets(store);
    const firstBoot = { ...pickManaged() };

    for (const name of MANAGED_SECRET_NAMES) delete process.env[name];
    const generated = await bootstrapSecrets(store);

    expect(pickManaged()).toEqual(firstBoot);
    expect(generated).toEqual([]);
  });
});

function pickManaged(): Record<string, string | undefined> {
  return Object.fromEntries(MANAGED_SECRET_NAMES.map((name) => [name, process.env[name]]));
}
