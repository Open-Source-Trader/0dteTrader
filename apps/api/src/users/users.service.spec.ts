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

  const addSnapTradeCredential = (userId: string, environment: 'live' | 'practice') => {
    prisma.brokerCredentials.push({
      id: `snaptrade-${environment}`,
      userId,
      provider: 'snaptrade',
      environment,
      encSecrets: Buffer.from(
        JSON.stringify({ provider: 'snaptrade', clientId: 'c1', consumerKey: 'k1' }),
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
      tradierConfigured: false,
      tradierPracticeConfigured: false,
      snaptradeKeyConfigured: false,
      snaptradeKeyPracticeConfigured: false,
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

  it('reports Tradier API-key flags from broker_credentials', async () => {
    const userId = await seedUser();
    prisma.brokerCredentials.push({
      id: 'tradier-live',
      userId,
      provider: 'tradier',
      environment: 'live',
      encSecrets: Buffer.from(JSON.stringify({ provider: 'tradier', apiKey: 'tk' })),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const me = await users.getMe(userId);
    expect(me.tradierConfigured).toBe(true);
    expect(me.tradierPracticeConfigured).toBe(false);
  });

  it('reports SnapTrade key-configured flags per environment, independent of connection status', async () => {
    const userId = await seedUser();
    addSnapTradeCredential(userId, 'practice');

    const me = await users.getMe(userId);
    expect(me.snaptradeKeyConfigured).toBe(false);
    expect(me.snaptradeKeyPracticeConfigured).toBe(true);
    // No brokerConnection row exists yet — connection flags stay false even
    // though the practice key is saved (they're independent concerns).
    expect(me.snaptradeConfigured).toBe(false);
    expect(me.snaptradePracticeConfigured).toBe(false);

    addSnapTradeCredential(userId, 'live');
    const meBoth = await users.getMe(userId);
    expect(meBoth.snaptradeKeyConfigured).toBe(true);
    expect(meBoth.snaptradeKeyPracticeConfigured).toBe(true);
  });

  it('reports SnapTrade connection flags per environment, independent of each other', async () => {
    const userId = await seedUser();
    prisma.brokerConnections.push({
      id: 'snaptrade-conn-live',
      userId,
      provider: 'snaptrade',
      environment: 'live',
      connectionId: 'conn-live',
      accountIds: ['acct-live'],
      selectedAccountId: 'acct-live',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const me = await users.getMe(userId);
    expect(me.snaptradeConfigured).toBe(true);
    expect(me.snaptradeAccountId).toBe('acct-live');
    // No practice connection row exists — must not inherit the live one.
    expect(me.snaptradePracticeConfigured).toBe(false);
    expect(me.snaptradePracticeAccountId).toBeNull();

    prisma.brokerConnections.push({
      id: 'snaptrade-conn-practice',
      userId,
      provider: 'snaptrade',
      environment: 'practice',
      connectionId: 'conn-practice',
      accountIds: ['acct-practice'],
      selectedAccountId: 'acct-practice',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const meBoth = await users.getMe(userId);
    expect(meBoth.snaptradeConfigured).toBe(true);
    expect(meBoth.snaptradeAccountId).toBe('acct-live');
    expect(meBoth.snaptradePracticeConfigured).toBe(true);
    expect(meBoth.snaptradePracticeAccountId).toBe('acct-practice');
  });

  it('requires the account email and cascades every user-owned record on deletion', async () => {
    const userId = await seedUser();
    const otherUserId = (
      await prisma.user.create({
        data: { email: 'other@example.com', passwordHash: 'hash' },
      })
    ).id as string;
    const now = new Date();
    const ownedTables = [
      prisma.credentials,
      prisma.refreshTokens,
      prisma.orderAudits,
      prisma.chartOrders,
      prisma.bracketGroups,
      prisma.brokerCredentials,
      prisma.brokerApiTokens,
      prisma.brokerConnections,
      prisma.deviceTokens,
      prisma.pushDeliveries,
      prisma.webhookInboxRows,
      prisma.userEvents,
      prisma.discordSettingsRows,
      prisma.discordDeliveries,
      prisma.legalAcceptances,
    ];
    for (const [index, table] of ownedTables.entries()) {
      table.push({ id: `owned-${index}`, userId }, { id: `other-${index}`, userId: otherUserId });
    }
    prisma.tradeOrders.push(
      { id: 'owned-order', userId, placedAt: now },
      { id: 'other-order', userId: otherUserId, placedAt: now },
    );
    prisma.tradeOrderExecutions.push(
      { id: 'owned-execution', orderId: 'owned-order' },
      { id: 'other-execution', orderId: 'other-order' },
    );

    await expect(users.deleteAccount(userId, 'wrong@example.com')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await users.deleteAccount(userId, ' U@EXAMPLE.COM ');

    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull();
    expect(await prisma.user.findUnique({ where: { id: otherUserId } })).not.toBeNull();
    for (const table of ownedTables) {
      expect(table.some((row) => row.userId === userId)).toBe(false);
      expect(table.some((row) => row.userId === otherUserId)).toBe(true);
    }
    expect(prisma.tradeOrders.map((row) => row.id)).toEqual(['other-order']);
    expect(prisma.tradeOrderExecutions.map((row) => row.id)).toEqual(['other-execution']);
  });
});
