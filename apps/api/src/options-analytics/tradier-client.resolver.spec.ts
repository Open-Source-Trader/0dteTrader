import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InMemoryPrismaService } from '../../test/in-memory-prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { CryptoService } from '../credentials/crypto.service';
import { TradierClient } from './tradier.client';
import { TRADIER_SANDBOX_BASE_URL, TradierClientResolver } from './tradier-client.resolver';

const PROD_BASE_URL = 'https://api.tradier.com';

describe('TradierClientResolver', () => {
  let prisma: InMemoryPrismaService;
  let credentials: CredentialsService;
  let shared: TradierClient;
  let factoryCalls: Array<{ token: string; baseUrl: string }>;
  let resolver: TradierClientResolver;

  let userSeq = 0;
  const seedUser = async (tradingMode: 'live' | 'practice' = 'live'): Promise<string> => {
    const row = await prisma.user.create({
      data: { email: `u${(userSeq += 1)}@example.com`, passwordHash: 'hash' },
    });
    const id = row.id as string;
    if (tradingMode !== 'live') {
      await prisma.user.update({ where: { id }, data: { tradingMode } });
    }
    return id;
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    prisma = new InMemoryPrismaService();
    const crypto = new CryptoService(new ConfigService({}));
    crypto.onModuleInit();
    credentials = new CredentialsService(
      prisma as unknown as ConstructorParameters<typeof CredentialsService>[0],
      crypto,
    );
    shared = new TradierClient('env-token', PROD_BASE_URL);
    factoryCalls = [];
    resolver = new TradierClientResolver(
      new ConfigService({ tradier: { token: 'env-token', baseUrl: PROD_BASE_URL } }),
      credentials,
      prisma as unknown as ConstructorParameters<typeof TradierClientResolver>[2],
      shared,
      (token, baseUrl) => {
        factoryCalls.push({ token, baseUrl });
        return new TradierClient(token, baseUrl);
      },
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Jump past RESOLUTION_TTL_MS so the next resolve re-reads the DB. */
  const expireResolutionTtl = () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(Date.now() + 6_000);
  };

  it('resolves the shared client without a user context', async () => {
    const resolved = await resolver.resolve();
    expect(resolved.client).toBe(shared);
    expect(resolved.scope).toBe('shared');
  });

  it('resolves the shared client when the user has no stored key', async () => {
    const userId = await seedUser();
    const resolved = await resolver.resolve(userId);
    expect(resolved.client).toBe(shared);
    expect(resolved.scope).toBe('shared');
    expect(factoryCalls).toHaveLength(0);
  });

  it('builds a per-user client from the stored live key and caches it', async () => {
    const userId = await seedUser();
    await credentials.save(userId, { provider: 'tradier', apiKey: 'user-key' });

    const first = await resolver.resolve(userId);
    expect(factoryCalls).toEqual([{ token: 'user-key', baseUrl: PROD_BASE_URL }]);
    expect(first.client).not.toBe(shared);
    expect(first.scope).not.toBe('shared');

    const second = await resolver.resolve(userId);
    expect(second.client).toBe(first.client);
    expect(factoryCalls).toHaveLength(1);
  });

  it('rebuilds the client (new scope) when the key is re-saved, once the memo expires', async () => {
    const userId = await seedUser();
    await credentials.save(userId, { provider: 'tradier', apiKey: 'key-1' });
    const first = await resolver.resolve(userId);

    await credentials.save(userId, { provider: 'tradier', apiKey: 'key-2' });
    // Within the resolution TTL the old client is still served (bounded staleness)…
    expect((await resolver.resolve(userId)).client).toBe(first.client);

    // …and after it expires the re-saved key takes effect.
    expireResolutionTtl();
    const second = await resolver.resolve(userId);
    expect(second.client).not.toBe(first.client);
    expect(second.scope).not.toBe(first.scope);
    expect(factoryCalls.map((c) => c.token)).toEqual(['key-1', 'key-2']);
  });

  it('memoizes resolutions (including "no key") so repeats skip the DB', async () => {
    const userId = await seedUser();
    await credentials.save(userId, { provider: 'tradier', apiKey: 'user-key' });
    await resolver.resolve(userId);

    const userReads = jest.spyOn(prisma.user, 'findUnique');
    await resolver.resolve(userId);
    expect(userReads).not.toHaveBeenCalled();

    // Negative result is memoized too.
    const keyless = await seedUser();
    await resolver.resolve(keyless);
    userReads.mockClear();
    expect((await resolver.resolve(keyless)).scope).toBe('shared');
    expect(userReads).not.toHaveBeenCalled();
  });

  it('uses the sandbox base URL for a practice-mode user with a sandbox key', async () => {
    const userId = await seedUser('practice');
    await credentials.save(userId, { provider: 'tradier', apiKey: 'sandbox-key' }, 'practice');

    await resolver.resolve(userId);
    expect(factoryCalls).toEqual([{ token: 'sandbox-key', baseUrl: TRADIER_SANDBOX_BASE_URL }]);
  });

  it('falls back to the live key for a practice-mode user without a sandbox key', async () => {
    const userId = await seedUser('practice');
    await credentials.save(userId, { provider: 'tradier', apiKey: 'live-key' });

    await resolver.resolve(userId);
    expect(factoryCalls).toEqual([{ token: 'live-key', baseUrl: PROD_BASE_URL }]);
  });

  it('never serves a sandbox key to a live-mode user', async () => {
    const userId = await seedUser('live');
    await credentials.save(userId, { provider: 'tradier', apiKey: 'sandbox-key' }, 'practice');

    const resolved = await resolver.resolve(userId);
    expect(resolved.client).toBe(shared);
    expect(factoryCalls).toHaveLength(0);
  });

  it('degrades to the shared client when the stored blob is corrupt — and memoizes the failure', async () => {
    const userId = await seedUser();
    prisma.brokerCredentials.push({
      id: 'bad',
      userId,
      provider: 'tradier',
      environment: 'live',
      encSecrets: Buffer.from('not-a-valid-blob'),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const resolved = await resolver.resolve(userId);
    expect(resolved.client).toBe(shared);
    expect(resolved.scope).toBe('shared');

    // The failure is memoized like any resolution: an unhealthy blob/DB is
    // not re-read (and re-warned) on every market-data request.
    const userReads = jest.spyOn(prisma.user, 'findUnique');
    expect((await resolver.resolve(userId)).client).toBe(shared);
    expect(userReads).not.toHaveBeenCalled();
  });

  it('reuses the last-known-good client when a refresh fails past the TTL', async () => {
    const userId = await seedUser();
    await credentials.save(userId, { provider: 'tradier', apiKey: 'user-key' });
    const first = await resolver.resolve(userId);

    expireResolutionTtl();
    jest.spyOn(prisma.user, 'findUnique').mockRejectedValueOnce(new Error('db blip'));
    const second = await resolver.resolve(userId);
    expect(second.client).toBe(first.client);
    expect(second.scope).toBe(first.scope);
  });

  it('verifyKey rejects a token Tradier answers with 401, and only that', async () => {
    const rejecting = {
      getExpirations: async () => {
        throw new Error('Tradier /markets/options/expirations -> HTTP 401');
      },
    } as unknown as TradierClient;
    const flaky = {
      getExpirations: async () => {
        throw new Error('Tradier /markets/options/expirations -> HTTP 502');
      },
    } as unknown as TradierClient;
    const ok = { getExpirations: async () => ['2026-08-20'] } as unknown as TradierClient;

    const make = (client: TradierClient) =>
      new TradierClientResolver(
        new ConfigService({ tradier: { baseUrl: PROD_BASE_URL } }),
        credentials,
        prisma as unknown as ConstructorParameters<typeof TradierClientResolver>[2],
        shared,
        () => client,
      );

    await expect(make(rejecting).verifyKey('bad-key', 'live')).rejects.toMatchObject({
      code: 'TRADIER_KEY_INVALID',
    });
    // Missing/blank keys are rejected before any network call.
    await expect(make(ok).verifyKey(undefined, 'live')).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    await expect(make(ok).verifyKey('  ', 'live')).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    // A Tradier outage must not block saving a possibly-valid key.
    await expect(make(flaky).verifyKey('maybe-key', 'live')).resolves.toBeUndefined();
    await expect(make(ok).verifyKey('good-key', 'live')).resolves.toBeUndefined();
  });

  it('pins a credential to the shared client after a request-time 401', async () => {
    const userId = await seedUser();
    await credentials.save(userId, { provider: 'tradier', apiKey: 'revoked-key' });
    const rejecting = {
      getChartQuote: async () => {
        throw new Error('Tradier /markets/quotes -> HTTP 401');
      },
    } as unknown as TradierClient;
    resolver = new TradierClientResolver(
      new ConfigService({ tradier: { baseUrl: PROD_BASE_URL } }),
      credentials,
      prisma as unknown as ConstructorParameters<typeof TradierClientResolver>[2],
      shared,
      (token, baseUrl) => {
        factoryCalls.push({ token, baseUrl });
        return rejecting;
      },
    );

    const resolved = await resolver.resolve(userId);
    await expect(
      (resolved.client as unknown as { getChartQuote(s: string): Promise<unknown> }).getChartQuote(
        'SPX',
      ),
    ).rejects.toThrow('HTTP 401');

    // The revoked key now degrades to the shared client instead of failing
    // every request — until a different key is saved.
    expect((await resolver.resolve(userId)).client).toBe(shared);
    await credentials.save(userId, { provider: 'tradier', apiKey: 'new-key' });
    expireResolutionTtl();
    await resolver.resolve(userId);
    expect(factoryCalls.map((c) => c.token)).toEqual(['revoked-key', 'new-key']);
  });
});
