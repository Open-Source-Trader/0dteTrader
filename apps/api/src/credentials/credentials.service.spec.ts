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
    expect(prisma.credentials).toHaveLength(2);

    const live = await service.getDecrypted('u1');
    const practice = await service.getDecrypted('u1', 'practice');
    expect(live).toEqual({ appKey: 'lak', appSecret: 'lsk', accountId: 'lacct' });
    expect(practice).toEqual({ appKey: 'pak', appSecret: 'psk', accountId: 'pacct' });
  });

  it('upserts within an environment without touching the other', async () => {
    await service.save('u1', { appKey: 'lak', appSecret: 'lsk', accountId: 'lacct' });
    await service.save('u1', { appKey: 'pak', appSecret: 'psk', accountId: 'pacct' }, 'practice');
    await service.save(
      'u1',
      { appKey: 'pak2', appSecret: 'psk2', accountId: 'pacct2' },
      'practice',
    );
    expect(prisma.credentials).toHaveLength(2);
    expect(await service.getDecrypted('u1', 'practice')).toMatchObject({
      appKey: 'pak2',
    });
    expect(await service.getDecrypted('u1')).toMatchObject({ appKey: 'lak' });
  });

  it('remove is environment-scoped and idempotent', async () => {
    await service.save('u1', { appKey: 'lak', appSecret: 'lsk', accountId: 'lacct' });
    await service.save('u1', { appKey: 'pak', appSecret: 'psk', accountId: 'pacct' }, 'practice');

    await service.remove('u1', 'practice');
    await service.remove('u1', 'practice'); // idempotent
    expect(await service.getDecrypted('u1', 'practice')).toBeNull();
    expect(await service.getDecrypted('u1')).toMatchObject({ appKey: 'lak' });

    await service.remove('u1');
    expect(await service.getDecrypted('u1')).toBeNull();
  });
});
