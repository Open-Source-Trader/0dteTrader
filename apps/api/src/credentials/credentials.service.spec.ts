import { ConfigService } from '@nestjs/config';
import { InMemoryPrismaService } from '../../test/in-memory-prisma.service';
import { CredentialsService } from './credentials.service';
import { CryptoService } from './crypto.service';
import { SnapTradeSecrets } from '@0dtetrader/shared-types';

describe('CredentialsService', () => {
  let prisma: InMemoryPrismaService;
  let service: CredentialsService;

  beforeEach(() => {
    prisma = new InMemoryPrismaService();
    const crypto = new CryptoService(new ConfigService({}));
    crypto.onModuleInit();
    service = new CredentialsService(
      prisma as unknown as ConstructorParameters<typeof CredentialsService>[0],
      crypto,
    );
  });

  it('stores one credential set per environment', async () => {
    await service.save('u1', { appKey: 'lak', appSecret: 'lsk', accountId: 'lacct' });
    await service.save('u1', { appKey: 'pak', appSecret: 'psk', accountId: 'pacct' }, 'practice');
    expect(prisma.brokerCredentials).toHaveLength(2);

    const live = await service.getDecrypted('u1', 'webull');
    const practice = await service.getDecrypted('u1', 'webull', 'practice');
    expect(live).toEqual({
      provider: 'webull',
      appKey: 'lak',
      appSecret: 'lsk',
      accountId: 'lacct',
    });
    expect(practice).toEqual({
      provider: 'webull',
      appKey: 'pak',
      appSecret: 'psk',
      accountId: 'pacct',
    });
  });

  it('upserts within an environment without touching the other', async () => {
    await service.save('u1', { appKey: 'lak', appSecret: 'lsk', accountId: 'lacct' });
    await service.save('u1', { appKey: 'pak', appSecret: 'psk', accountId: 'pacct' }, 'practice');
    await service.save(
      'u1',
      { appKey: 'pak2', appSecret: 'psk2', accountId: 'pacct2' },
      'practice',
    );
    expect(prisma.brokerCredentials).toHaveLength(2);
    expect(await service.getDecrypted('u1', 'webull', 'practice')).toMatchObject({
      appKey: 'pak2',
    });
    expect(await service.getDecrypted('u1', 'webull')).toMatchObject({ appKey: 'lak' });
  });

  it('remove is environment-scoped and idempotent', async () => {
    await service.save('u1', { appKey: 'lak', appSecret: 'lsk', accountId: 'lacct' });
    await service.save('u1', { appKey: 'pak', appSecret: 'psk', accountId: 'pacct' }, 'practice');

    await service.remove('u1', 'webull', 'practice');
    await service.remove('u1', 'webull', 'practice'); // idempotent
    expect(await service.getDecrypted('u1', 'webull', 'practice')).toBeNull();
    expect(await service.getDecrypted('u1', 'webull')).toMatchObject({ appKey: 'lak' });

    await service.remove('u1', 'webull');
    expect(await service.getDecrypted('u1', 'webull')).toBeNull();
  });

  it('round-trips Alpaca credentials through the encrypted blob', async () => {
    await service.save('u1', { provider: 'alpaca', apiKey: 'ak', apiSecret: 'as' });
    expect(prisma.brokerCredentials).toHaveLength(1);
    expect(prisma.brokerCredentials[0].provider).toBe('alpaca');
    expect(await service.getDecrypted('u1', 'alpaca')).toEqual({
      provider: 'alpaca',
      apiKey: 'ak',
      apiSecret: 'as',
    });
  });

  it('round-trips the Tradier API key through the encrypted blob', async () => {
    await service.save('u1', { provider: 'tradier', apiKey: 'tk' });
    await service.save('u1', { provider: 'tradier', apiKey: 'tks' }, 'practice');
    expect(prisma.brokerCredentials).toHaveLength(2);
    expect(prisma.brokerCredentials[0].provider).toBe('tradier');
    expect(await service.getDecrypted('u1', 'tradier')).toEqual({
      provider: 'tradier',
      apiKey: 'tk',
    });
    expect(await service.getDecrypted('u1', 'tradier', 'practice')).toEqual({
      provider: 'tradier',
      apiKey: 'tks',
    });
  });

  it('stores secrets trimmed — a pasted trailing newline must never reach an Authorization header', async () => {
    await service.save('u1', { provider: 'tradier', apiKey: '  tk-123\n' });
    expect(await service.getDecrypted('u1', 'tradier')).toEqual({
      provider: 'tradier',
      apiKey: 'tk-123',
    });

    await service.save('u1', { provider: 'alpaca', apiKey: ' ak\n', apiSecret: 'as\r\n' });
    expect(await service.getDecrypted('u1', 'alpaca')).toEqual({
      provider: 'alpaca',
      apiKey: 'ak',
      apiSecret: 'as',
    });
  });

  it('returns all of a provider rows keyed by environment in one query (no webull shim)', async () => {
    await service.save('u1', { provider: 'tradier', apiKey: 'tk-live' });
    await service.save('u1', { provider: 'tradier', apiKey: 'tk-sandbox' }, 'practice');
    const rows = await service.getDecryptedProviderRows('u1', 'tradier');
    expect(rows).toEqual({
      live: { provider: 'tradier', apiKey: 'tk-live' },
      practice: { provider: 'tradier', apiKey: 'tk-sandbox' },
    });
    expect(await service.getDecryptedProviderRows('u1', 'alpaca')).toEqual({});
  });

  it('rejects a save whose provider secret fields are missing or blank', async () => {
    // The generic PUT body is a TS union with no class-validator DTO, so the
    // service is the last line of defense against storing a garbage blob.
    await expect(service.save('u1', { provider: 'tradier' } as never)).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    await expect(service.save('u1', { provider: 'tradier', apiKey: '  ' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    await expect(
      service.save('u1', { provider: 'alpaca', apiKey: 'ak' } as never),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(
      service.save('u1', { provider: 'webull', appKey: 'k' } as never),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(prisma.brokerCredentials).toHaveLength(0);
  });

  it('persists SnapTrade identity via saveSnapTradeIdentity', async () => {
    const identity: SnapTradeSecrets = {
      provider: 'snaptrade',
      snaptradeUserId: 'uid-1',
      snaptradeUserSecret: 'secret-1',
    };
    await service.saveSnapTradeIdentity('u1', identity);
    expect(prisma.brokerCredentials).toHaveLength(1);
    expect(prisma.brokerCredentials[0].provider).toBe('snaptrade');

    const retrieved = await service.getSnapTradeIdentity('u1');
    expect(retrieved).toEqual(identity);
  });

  it('saveSnapTradeIdentity is idempotent (upsert)', async () => {
    const identity: SnapTradeSecrets = {
      provider: 'snaptrade',
      snaptradeUserId: 'uid-1',
      snaptradeUserSecret: 'secret-1',
    };
    await service.saveSnapTradeIdentity('u1', identity);
    await service.saveSnapTradeIdentity('u1', {
      ...identity,
      snaptradeUserSecret: 'secret-2',
    });
    expect(prisma.brokerCredentials).toHaveLength(1);
    expect(await service.getSnapTradeIdentity('u1')).toEqual({
      ...identity,
      snaptradeUserSecret: 'secret-2',
    });
  });

  it('returns null when no SnapTrade identity is stored', async () => {
    expect(await service.getSnapTradeIdentity('u1')).toBeNull();
  });

  it('getSnapTradeIdentity is environment-scoped', async () => {
    const liveIdentity: SnapTradeSecrets = {
      provider: 'snaptrade',
      snaptradeUserId: 'uid-live',
      snaptradeUserSecret: 'secret-live',
    };
    await service.saveSnapTradeIdentity('u1', liveIdentity);
    await service.saveSnapTradeIdentity(
      'u1',
      { provider: 'snaptrade', snaptradeUserId: 'uid-prac', snaptradeUserSecret: 'secret-prac' },
      'practice',
    );

    expect(await service.getSnapTradeIdentity('u1')).toEqual(liveIdentity);
    expect(await service.getSnapTradeIdentity('u1', 'practice')).toEqual({
      provider: 'snaptrade',
      snaptradeUserId: 'uid-prac',
      snaptradeUserSecret: 'secret-prac',
    });
  });

  it('toSecrets maps SnapTrade input to SnapTradeSecrets', async () => {
    // Accessible indirectly: saving a SnapTrade identity stores it encrypted
    // and getDecrypted returns the raw broker_credentials blob, which is
    // keyed on provider — proving the discriminator is preserved.
    await service.save('u1', {
      provider: 'snaptrade',
      snaptradeUserId: 'uid-x',
      snaptradeUserSecret: 'secret-x',
    } as any);
    const row = prisma.brokerCredentials[0];
    expect(row.provider).toBe('snaptrade');
    const decrypted = await service.getDecrypted('u1', 'snaptrade');
    expect(decrypted).toEqual<SnapTradeSecrets>({
      provider: 'snaptrade',
      snaptradeUserId: 'uid-x',
      snaptradeUserSecret: 'secret-x',
    });
  });
});
