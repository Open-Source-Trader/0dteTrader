import { INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { setupOpenApi } from '../src/openapi';
import { PrismaService } from '../src/prisma/prisma.service';
import { InMemoryPrismaService } from './in-memory-prisma.service';

/**
 * The OpenAPI document must be served at /openapi.json (outside the /v1
 * prefix) with the prefixed route paths inside — the Mayhem for API CI
 * workflow discovers fuzz targets from it, so a regression here silently
 * turns that scan into a no-op.
 */
describe('OpenAPI document (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(new InMemoryPrismaService())
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useWebSocketAdapter(new WsAdapter(app));
    setupOpenApi(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the spec at /openapi.json with prefixed route paths', async () => {
    const res = await request(app.getHttpServer()).get('/openapi.json').expect(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.info.title).toBe('0dteTrader API');
    const paths = Object.keys(res.body.paths);
    expect(paths).toContain('/v1/health');
    expect(paths).toContain('/v1/auth/login');
    expect(paths.every((p) => p.startsWith('/v1/'))).toBe(true);
  });

  it('does not serve the Swagger UI', async () => {
    await request(app.getHttpServer()).get('/docs').expect(404);
  });
});
