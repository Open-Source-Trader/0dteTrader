import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import type { LogLevel } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import helmet from 'helmet';
import { AppLogger } from './common/app-logger';
import { bootstrapSecrets } from './config/secret-bootstrap';
import { setupOpenApi } from './openapi';

/**
 * Fill unset security env vars from (or into) the database before the config
 * module's fail-fast validation runs. Skipped when DATABASE_URL is unset
 * (unit-test contexts). Uses a throwaway client: the app's PrismaService does
 * not exist until Nest constructs it, which is after env validation.
 */
async function bootstrapSecretsFromDb(logger: AppLogger): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    const generated = await bootstrapSecrets(prisma);
    if (generated.length > 0) {
      logger.log(`Generated and persisted fallback secrets: ${generated.join(', ')}`, 'Bootstrap');
    }
  } finally {
    await prisma.$disconnect();
  }
}

/** Nest's ConsoleLogger defaults to every level including debug/verbose — the
 *  timing spans in common/timing.ts print unless LOG_LEVEL narrows this. */
function logLevelsFromEnv(): LogLevel[] | undefined {
  const raw = process.env.LOG_LEVEL;
  if (!raw) return undefined;
  return raw
    .split(',')
    .map((level) => level.trim())
    .filter((level): level is LogLevel =>
      ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'].includes(level),
    );
}

async function bootstrap(): Promise<void> {
  const logger = new AppLogger(undefined, logLevelsFromEnv());
  await bootstrapSecretsFromDb(logger);

  // app.module calls ConfigModule.forRoot() — and its fail-fast validateEnv —
  // at module-evaluation time, so it must not be imported until the secret
  // bootstrap has filled process.env.
  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.create(AppModule, {
    logger,
  });

  app.use(helmet());
  app.enableCors();
  app.setGlobalPrefix('v1');
  app.useWebSocketAdapter(new WsAdapter(app));
  setupOpenApi(app);

  const config = app.get(ConfigService);
  const port = config.get<number>('port', 3000);
  await app.listen(port);
}

void bootstrap();
