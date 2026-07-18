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
    prisma.credentials.push({
      id: `cred-${environment}`,
      userId,
      environment,
      encAppKey: Buffer.from('x'),
      encAppSecret: Buffer.from('y'),
      encAccountId: Buffer.from('z'),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  };

  beforeEach(() => {
    prisma = new InMemoryPrismaService();
    users = new UsersService(
      prisma as unknown as ConstructorParameters<typeof UsersService>[0],
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
      webullConfigured: false,
      webullPracticeConfigured: false,
    });

    addCredential(userId, 'practice');
    me = await users.getMe(userId);
    expect(me.webullConfigured).toBe(false);
    expect(me.webullPracticeConfigured).toBe(true);

    addCredential(userId, 'live');
    me = await users.getMe(userId);
    expect(me.webullConfigured).toBe(true);
    expect(me.webullPracticeConfigured).toBe(true);
  });

  it('setTradingMode persists the mode and returns the updated Me', async () => {
    const userId = await seedUser();

    const me = await users.setTradingMode(userId, 'practice');
    expect(me.tradingMode).toBe('practice');
    expect((await users.getMe(userId)).tradingMode).toBe('practice');

    expect((await users.setTradingMode(userId, 'live')).tradingMode).toBe('live');
  });

  it('rejects with USER_NOT_FOUND for unknown users', async () => {
    await expect(users.getMe('missing')).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
    });
  });
});
