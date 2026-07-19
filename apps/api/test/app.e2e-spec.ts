import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { BROKER_GATEWAY } from '../src/broker/broker-gateway.interface';
import { PrismaService } from '../src/prisma/prisma.service';
import { InMemoryPrismaService } from './in-memory-prisma.service';
import { StubBrokerGateway } from './stub-broker.gateway';

/**
 * Full-stack e2e over HTTP (supertest). The whole Nest app boots for real;
 * only PrismaService is swapped for the in-memory fake and BROKER_GATEWAY for
 * the deterministic StubBrokerGateway, so neither Postgres nor a Webull
 * account is needed. Rate limiting is skipped under NODE_ENV=test (see
 * app.module).
 */
describe('0dteTrader API (e2e)', () => {
  let app: INestApplication;
  let prisma: InMemoryPrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;

  const user = { email: 'e2e@example.com', password: 'e2e-password-1' };
  let accessToken = '';
  let refreshToken = '';
  let userId = '';

  beforeAll(async () => {
    prisma = new InMemoryPrismaService();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(BROKER_GATEWAY)
      .useValue(new StubBrokerGateway())
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers a user and returns AuthTokens', async () => {
    const res = await request(server)
      .post('/v1/auth/register')
      .send(user)
      .expect(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.expiresIn).toBe(900);
    accessToken = res.body.accessToken;
    refreshToken = res.body.refreshToken;

    const payload = JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64url').toString(),
    );
    userId = payload.sub;
    expect(userId).toBeTruthy();
  });

  it('rejects duplicate registration with 409 EMAIL_TAKEN', async () => {
    const res = await request(server)
      .post('/v1/auth/register')
      .send(user)
      .expect(409);
    expect(res.body).toEqual({
      error: { code: 'EMAIL_TAKEN', message: expect.any(String) },
    });
  });

  it('rejects invalid registration payloads with 400 VALIDATION_ERROR', async () => {
    const res = await request(server)
      .post('/v1/auth/register')
      .send({ email: 'not-an-email', password: 'short' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('logs in and rejects bad credentials', async () => {
    const ok = await request(server)
      .post('/v1/auth/login')
      .send(user)
      .expect(200);
    expect(ok.body.accessToken).toBeTruthy();

    const bad = await request(server)
      .post('/v1/auth/login')
      .send({ ...user, password: 'wrong-password' })
      .expect(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('protects routes: 401 without a token', async () => {
    const res = await request(server).get('/v1/me').expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('GET /v1/me returns the profile with webullConfigured=false', async () => {
    const res = await request(server)
      .get('/v1/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body).toEqual({
      id: userId,
      email: user.email,
      tradingDisabled: false,
      tradingMode: 'live',
      webullConfigured: false,
      webullPracticeConfigured: false,
    });
  });

  it('PATCH /v1/me switches the trading mode and validates the value', async () => {
    const patched = await request(server)
      .patch('/v1/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ tradingMode: 'practice' })
      .expect(200);
    expect(patched.body.tradingMode).toBe('practice');

    const me = await request(server)
      .get('/v1/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(me.body.tradingMode).toBe('practice');

    await request(server)
      .patch('/v1/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ tradingMode: 'demo' })
      .expect(400);

    const back = await request(server)
      .patch('/v1/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ tradingMode: 'live' })
      .expect(200);
    expect(back.body.tradingMode).toBe('live');
  });

  it('saves Webull credentials (never echoed back) and reflects it in /me', async () => {
    const put = await request(server)
      .put('/v1/me/webull-credentials')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ appKey: 'ak', appSecret: 'sk', accountId: 'acct-1' })
      .expect(200);
    expect(put.body).toEqual({ webullConfigured: true, environment: 'live' });
    expect(JSON.stringify(put.body)).not.toContain('sk');

    const me = await request(server)
      .get('/v1/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(me.body.webullConfigured).toBe(true);

    // Stored encrypted: no plaintext anywhere in the credential row.
    expect(prisma.credentials).toHaveLength(1);
    const row = prisma.credentials[0];
    for (const field of ['encAppKey', 'encAppSecret', 'encAccountId']) {
      expect(Buffer.isBuffer(row[field])).toBe(true);
      expect(row[field].toString('utf8')).not.toMatch(/ak|sk|acct-1/);
    }
  });

  it('deletes Webull credentials (204, idempotent)', async () => {
    await request(server)
      .delete('/v1/me/webull-credentials')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);
    await request(server)
      .delete('/v1/me/webull-credentials')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);
    const me = await request(server)
      .get('/v1/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(me.body.webullConfigured).toBe(false);

    // Re-save for the trading flow below.
    await request(server)
      .put('/v1/me/webull-credentials')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ appKey: 'ak', appSecret: 'sk', accountId: 'acct-1' })
      .expect(200);
  });

  it('stores credentials per environment (live / practice)', async () => {
    const auth = { Authorization: `Bearer ${accessToken}` };

    // Live credentials already exist from the tests above; add practice.
    const put = await request(server)
      .put('/v1/me/webull-credentials')
      .set(auth)
      .send({ appKey: 'pak', appSecret: 'psk', accountId: 'pacct', environment: 'practice' })
      .expect(200);
    expect(put.body).toEqual({ webullConfigured: true, environment: 'practice' });

    let me = await request(server).get('/v1/me').set(auth).expect(200);
    expect(me.body.webullConfigured).toBe(true);
    expect(me.body.webullPracticeConfigured).toBe(true);
    expect(prisma.credentials).toHaveLength(2);

    // An invalid environment is rejected.
    await request(server)
      .put('/v1/me/webull-credentials')
      .set(auth)
      .send({ appKey: 'x', appSecret: 'y', accountId: 'z', environment: 'demo' })
      .expect(400);

    // Deleting practice leaves live untouched.
    await request(server)
      .delete('/v1/me/webull-credentials?environment=practice')
      .set(auth)
      .expect(204);
    me = await request(server).get('/v1/me').set(auth).expect(200);
    expect(me.body.webullConfigured).toBe(true);
    expect(me.body.webullPracticeConfigured).toBe(false);
  });

  it('serves market data (quote, candles, chain)', async () => {
    const auth = { Authorization: `Bearer ${accessToken}` };
    const quote = await request(server)
      .get('/v1/market/quote?symbol=SPY')
      .set(auth)
      .expect(200);
    expect(quote.body.last).toBeGreaterThan(0);
    expect(quote.body.bid).toBeLessThan(quote.body.ask);

    const candles = await request(server)
      .get('/v1/market/candles?symbol=SPY&interval=1m')
      .set(auth)
      .expect(200);
    expect(Array.isArray(candles.body)).toBe(true);
    expect(candles.body.length).toBeGreaterThan(0);
    expect(candles.body[0]).toMatchObject({
      time: expect.any(String),
      open: expect.any(Number),
      high: expect.any(Number),
      low: expect.any(Number),
      close: expect.any(Number),
      volume: expect.any(Number),
    });

    const chain = await request(server)
      .get('/v1/market/options-chain?symbol=SPY')
      .set(auth)
      .expect(200);
    expect(chain.body.underlying).toBe('SPY');
    expect(chain.body.expirations.length).toBeGreaterThanOrEqual(3);
    expect(chain.body.contracts.length).toBeGreaterThan(0);
  });

  it('previews an auto_otm order (server-resolved contract)', async () => {
    const res = await request(server)
      .post('/v1/orders/preview')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        underlying: 'SPY',
        assetClass: 'option',
        side: 'buy',
        quantity: 1,
        orderType: 'market',
        selection: { mode: 'auto_otm', optionType: 'call' },
      })
      .expect(200);
    expect(res.body.resolved.contractSymbol).toMatch(/^SPY\d{6}C\d{8}$/);
    expect(res.body.resolved.price).toBeGreaterThan(0);
    expect(res.body.resolved.estBuyingPower).toBeCloseTo(
      res.body.resolved.price * 100,
      2,
    );
    expect(Array.isArray(res.body.warnings)).toBe(true);
  });

  it('requires the Idempotency-Key header on POST /v1/orders', async () => {
    const res = await request(server)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        underlying: 'SPY',
        assetClass: 'option',
        side: 'buy',
        quantity: 1,
        orderType: 'market',
        selection: { mode: 'auto_otm', optionType: 'call' },
      })
      .expect(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  let placedOrderId = '';
  const orderBody = {
    underlying: 'SPY',
    assetClass: 'option',
    side: 'buy',
    quantity: 1,
    orderType: 'market',
    selection: { mode: 'auto_otm', optionType: 'call' },
  };

  it('places a market order (fills immediately)', async () => {
    const res = await request(server)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', 'e2e-key-1')
      .send(orderBody)
      .expect(200);
    expect(res.body.status).toBe('filled');
    expect(res.body.filledPrice).toBeGreaterThan(0);
    expect(res.body.contractSymbol).toMatch(/^SPY\d{6}C\d{8}$/);
    placedOrderId = res.body.orderId;
  });

  it('replays the same Idempotency-Key without a second fill', async () => {
    const res = await request(server)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', 'e2e-key-1')
      .send(orderBody)
      .expect(200);
    expect(res.body.orderId).toBe(placedOrderId);

    const audits = prisma.orderAudits.filter(
      (a) => a.idempotencyKey === 'e2e-key-1',
    );
    expect(audits).toHaveLength(1);
  });

  it('shows the new position', async () => {
    const res = await request(server)
      .get('/v1/positions')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      assetClass: 'option',
      quantity: 1,
      avgPrice: expect.any(Number),
      markPrice: expect.any(Number),
      unrealizedPnl: expect.any(Number),
    });
  });

  it('mid orders rest then fill; open orders list reflects them', async () => {
    const placed = await request(server)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', 'e2e-key-2')
      .send({ ...orderBody, orderType: 'mid', side: 'buy', quantity: 2 })
      .expect(200);
    expect(placed.body.status).toBe('submitted');
    expect(placed.body.limitPrice).toBeGreaterThan(0);

    const open = await request(server)
      .get('/v1/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(open.body.map((o: { orderId: string }) => o.orderId)).toContain(
      placed.body.orderId,
    );

    await new Promise((resolve) => setTimeout(resolve, 500));
    const openAfter = await request(server)
      .get('/v1/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(openAfter.body).toHaveLength(0);

    const positions = await request(server)
      .get('/v1/positions')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(positions.body).toHaveLength(1);
    expect(positions.body[0].quantity).toBe(3); // 1 market + 2 mid
  });

  it('cancels a resting order with 204', async () => {
    const placed = await request(server)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', 'e2e-key-3')
      .send({ ...orderBody, orderType: 'mid' })
      .expect(200);
    await request(server)
      .delete(`/v1/orders/${placed.body.orderId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);
    // Cancelling again reports it is no longer open.
    const again = await request(server)
      .delete(`/v1/orders/${placed.body.orderId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(400);
    expect(again.body.error.code).toBe('ORDER_NOT_OPEN');
  });

  it('kill switch blocks orders with 403 TRADING_DISABLED', async () => {
    prisma.setTradingDisabled(userId, true);
    const res = await request(server)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', 'e2e-key-4')
      .send(orderBody)
      .expect(403);
    expect(res.body.error.code).toBe('TRADING_DISABLED');
    prisma.setTradingDisabled(userId, false);

    const blocked = prisma.orderAudits.filter((a) => a.status === 'blocked');
    expect(blocked.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects malformed orders with 400 VALIDATION_ERROR', async () => {
    const res = await request(server)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', 'e2e-key-5')
      .send({ underlying: 'SPY', assetClass: 'option', side: 'hold', quantity: 0 })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('refresh rotates tokens; reuse revokes the family', async () => {
    const rotated = await request(server)
      .post('/v1/auth/refresh')
      .send({ refreshToken })
      .expect(200);
    expect(rotated.body.refreshToken).not.toEqual(refreshToken);

    // Replay of the rotated-out token → 401 REFRESH_TOKEN_REUSED.
    const reused = await request(server)
      .post('/v1/auth/refresh')
      .send({ refreshToken })
      .expect(401);
    expect(reused.body.error.code).toBe('REFRESH_TOKEN_REUSED');

    // The fresh token was family-revoked as well.
    await request(server)
      .post('/v1/auth/refresh')
      .send({ refreshToken: rotated.body.refreshToken })
      .expect(401);

    // Old access token still authenticates until it expires (stateless JWT).
    await request(server)
      .get('/v1/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
  });

  it('logout revokes the refresh token (204)', async () => {
    const login = await request(server)
      .post('/v1/auth/login')
      .send(user)
      .expect(200);
    await request(server)
      .post('/v1/auth/logout')
      .send({ refreshToken: login.body.refreshToken })
      .expect(204);
    await request(server)
      .post('/v1/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(401);
  });
});
