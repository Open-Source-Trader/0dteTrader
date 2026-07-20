// Prisma 7 moved the Migrate/CLI connection URL out of schema.prisma into
// this config file; the runtime client gets its connection via the pg driver
// adapter in src/prisma/prisma.service.ts. The CLI no longer auto-loads .env,
// so pull in dotenv here (root .env first, then local overrides).
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

loadEnv({ path: ['../../.env', '.env'] });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Fall back to the docker-compose dev database so URL-less commands like
    // `prisma generate` still work without a .env present.
    url: process.env.DATABASE_URL ?? 'postgresql://odtetrader:odtetrader@localhost:5432/odtetrader',
  },
});
