import { randomBytes } from 'crypto';

/**
 * Zero-config secret bootstrap for self-hosted deploys (Railway one-click).
 *
 * When a security-critical env var is absent, the value is loaded from the
 * runtime_secrets table — generated and persisted on first boot — so a deploy
 * with no configured secrets still passes the production checks in
 * configuration.ts. An env var, when set, always wins and is never written to
 * the database. Values are never logged; callers may log the returned names.
 *
 * Runs before ConfigModule loads any .env file, so a secret present only in a
 * .env file (with DATABASE_URL set as a real env var) would be shadowed by the
 * DB fallback — no current run path does this; keep it that way.
 */

const MANAGED_SECRETS: ReadonlyArray<{ name: string; generate: () => string }> = [
  { name: 'JWT_ACCESS_SECRET', generate: () => randomBytes(48).toString('base64url') },
  { name: 'JWT_REFRESH_SECRET', generate: () => randomBytes(48).toString('base64url') },
  // Must decode to exactly 32 base64 bytes (validateEnv enforces this).
  { name: 'CRED_ENCRYPTION_KEY', generate: () => randomBytes(32).toString('base64') },
];

export const MANAGED_SECRET_NAMES: readonly string[] = MANAGED_SECRETS.map((s) => s.name);

/** The slice of PrismaClient this module needs (kept narrow for tests). */
export interface SecretStore {
  runtimeSecret: {
    findUnique(args: { where: { name: string } }): Promise<{ name: string; value: string } | null>;
    createMany(args: {
      data: { name: string; value: string }[];
      skipDuplicates: boolean;
    }): Promise<{ count: number }>;
  };
}

/**
 * Fills process.env for each managed secret that is unset. Returns the names
 * (never the values) of secrets this call generated and persisted.
 */
export async function bootstrapSecrets(prisma: SecretStore): Promise<string[]> {
  const generated: string[] = [];

  for (const secret of MANAGED_SECRETS) {
    if (process.env[secret.name]) continue; // env wins; never touch the DB

    const existing = await prisma.runtimeSecret.findUnique({ where: { name: secret.name } });
    if (existing) {
      process.env[secret.name] = existing.value;
      continue;
    }

    // ON CONFLICT DO NOTHING, then re-read: two racing replicas both land on
    // whichever insert won.
    const inserted = await prisma.runtimeSecret.createMany({
      data: [{ name: secret.name, value: secret.generate() }],
      skipDuplicates: true,
    });
    const row = await prisma.runtimeSecret.findUnique({ where: { name: secret.name } });
    if (!row) {
      throw new Error(`secret bootstrap failed: ${secret.name} missing after insert`);
    }
    process.env[secret.name] = row.value;
    if (inserted.count > 0) generated.push(secret.name);
  }

  return generated;
}
