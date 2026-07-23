import { ConfigService } from '@nestjs/config';
import { InMemoryPrismaService } from '../../test/in-memory-prisma.service';
import { CredentialsService } from './credentials.service';
import { CryptoService } from './crypto.service';

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
});
