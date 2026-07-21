import { InMemoryPrismaService } from '../../test/in-memory-prisma.service';
import { UsersService } from './users.service';

describe('UsersService', () => {
  let prisma: InMemoryPrismaService;
  let users: UsersService;

  const seedUser = async (): Promise<string> => {
    const row = await prisma.user.create({
      data: { email: 'u@example.com', passwordHash: 'hash' },
    });
    return row.id as string;
  };

  const addCredential = (userId: string, environment: 'live' | 'practice') => {
    prisma.brokerCredentials.push({
      id: `cred-${environment}`,
      userId,
      provider: 'webull',
      environment,
      encSecrets: Buffer.from(
        JSON.stringify({ provider: 'webull', appKey: 'k', appSecret: 's', accountId: 'z' }),
      ),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  };

  const addAlpacaCredential = (userId: string, environment: 'live' | 'practice') => {
    prisma.brokerCredentials.push({
      id: `alpaca-${environment}`,
      userId,
      provider: 'alpaca',
      environment,
      encSecrets: Buffer.from(
        JSON.stringify({ provider: 'alpaca', apiKey: 'ak', apiSecret: 'as' }),
      ),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  };

  beforeEach(() => {
    prisma = new InMemoryPrismaService();
    const crypto = { decrypt: (buf: Buffer) => buf.toString() };
    users = new UsersService(
      prisma as unknown as ConstructorParameters<typeof UsersService>[0],
      crypto as unknown as ConstructorParameters<typeof UsersService>[1],
    );
  });

  it('maps Me with tradingMode and per-environment credential flags', async () => {
    const userId = await seedUser();

    let me = await users.getMe(userId);
    expect(me).toEqual({
      id: userId,
      email: 'u@example.com',
      tradingDisabled: false,
      tradingMode: 'live',
      tradingProvider: 'webull',
      webullConfigured: false,
      webullPracticeConfigured: false,
      webullAccountId: null,
      webullPracticeAccountId: null,
      alpacaConfigured: false,
      alpacaPracticeConfigured: false,
      alpacaAccountId: null,
      alpacaPracticeAccountId: null,
      snaptradeConfigured: false,
      snaptradePracticeConfigured: false,
      snaptradeAccountId: null,
      snaptradePracticeAccountId: null,
    });

    addCredential(userId, 'practice');
    me = await users.getMe(userId);
    expect(me.webullConfigured).toBe(false);
    expect(me.webullPracticeConfigured).toBe(true);
    expect(me.webullPracticeAccountId).toBe('z');

    addCredential(userId, 'live');
    me = await users.getMe(userId);
    expect(me.webullConfigured).toBe(true);
    expect(me.webullPracticeConfigured).toBe(true);
    expect(me.webullAccountId).toBe('z');
  });

  it('setTradingMode persists the mode and returns the updated Me', async () => {
    const userId = await seedUser();

    const me = await users.setTradingMode(userId, 'practice');
    expect(me.tradingMode).toBe('practice');
    expect((await users.getMe(userId)).tradingMode).toBe('practice');

    expect((await users.setTradingMode(userId, 'live')).tradingMode).toBe('live');
  });

  it('setTradingProvider persists the provider and returns the updated Me', async () => {
    const userId = await seedUser();
    const me = await users.setTradingProvider(userId, 'alpaca');
    expect(me.tradingProvider).toBe('alpaca');
    expect((await users.getMe(userId)).tradingProvider).toBe('alpaca');
    expect((await users.setTradingProvider(userId, 'webull')).tradingProvider).toBe('webull');
  });

  it('rejects with USER_NOT_FOUND for unknown users', async () => {
    await expect(users.getMe('missing')).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
    });
  });

  it('reports Alpaca credential flags from broker_credentials', async () => {
    const userId = await seedUser();
    addAlpacaCredential(userId, 'live');
    const me = await users.getMe(userId);
    expect(me.alpacaConfigured).toBe(true);
    expect(me.alpacaPracticeConfigured).toBe(false);
    expect(me.alpacaAccountId).toBeNull();
  });

  it('reports SnapTrade connection flags from broker_connections', async () => {
    const userId = await seedUser();
    prisma.brokerConnections.push({
      id: 'snaptrade-conn',
      userId,
      provider: 'snaptrade',
      connectionId: 'conn-1',
      accountIds: ['acct-1'],
      selectedAccountId: 'acct-1',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const me = await users.getMe(userId);
    expect(me.snaptradeConfigured).toBe(true);
    expect(me.snaptradePracticeConfigured).toBe(true);
    expect(me.snaptradeAccountId).toBe('acct-1');
    expect(me.snaptradePracticeAccountId).toBe('acct-1');
  });
});
