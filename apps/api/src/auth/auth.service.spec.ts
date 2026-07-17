import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InMemoryPrismaService } from '../../test/in-memory-prisma.service';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';

const config = new ConfigService({
  jwt: {
    accessSecret: 'unit-test-access-secret-0123456789',
    refreshSecret: 'unit-test-refresh-secret-0123456789',
    accessTtl: 900,
    refreshTtl: 1209600,
  },
});

function makeService(prisma: InMemoryPrismaService): AuthService {
  return new AuthService(
    prisma as unknown as ConstructorParameters<typeof AuthService>[0],
    new PasswordService(),
    new JwtService({}),
    config,
  );
}

describe('AuthService', () => {
  let prisma: InMemoryPrismaService;
  let auth: AuthService;

  beforeEach(() => {
    prisma = new InMemoryPrismaService();
    auth = makeService(prisma);
  });

  it('register issues a token pair and stores the user lowercased', async () => {
    const tokens = await auth.register('  Alice@Example.COM ', 'password123');
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    expect(tokens.expiresIn).toBe(900);
    expect(prisma.users).toHaveLength(1);
    expect(prisma.users[0].email).toBe('alice@example.com');
    expect(prisma.users[0].passwordHash).not.toContain('password123');
    // Only the SHA-256 hash of the refresh token is stored.
    expect(prisma.refreshTokens).toHaveLength(1);
    expect(prisma.refreshTokens[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prisma.refreshTokens[0].tokenHash).not.toBe(tokens.refreshToken);
  });

  it('register rejects duplicate emails with EMAIL_TAKEN (409)', async () => {
    await auth.register('bob@example.com', 'password123');
    await expect(auth.register('BOB@example.com', 'otherpass1')).rejects.toMatchObject({
      status: 409,
      code: 'EMAIL_TAKEN',
    });
  });

  it('login succeeds with valid credentials and fails otherwise (401)', async () => {
    await auth.register('carol@example.com', 'password123');
    const tokens = await auth.login('carol@example.com', 'password123');
    expect(tokens.accessToken).toBeTruthy();

    await expect(auth.login('carol@example.com', 'wrong-password')).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_CREDENTIALS',
    });
    await expect(auth.login('nobody@example.com', 'password123')).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_CREDENTIALS',
    });
  });

  it('access tokens verify against the access secret only', async () => {
    const jwt = new JwtService({});
    const tokens = await auth.register('dave@example.com', 'password123');
    const payload = await jwt.verifyAsync(tokens.accessToken, {
      secret: 'unit-test-access-secret-0123456789',
    });
    expect(payload.sub).toBe(prisma.users[0].id);
    expect(Object.keys(payload)).not.toContain('email');
    await expect(
      jwt.verifyAsync(tokens.accessToken, {
        secret: 'unit-test-refresh-secret-0123456789',
      }),
    ).rejects.toThrow();
  });

  it('refresh rotates the pair and revokes the presented token', async () => {
    const first = await auth.register('erin@example.com', 'password123');
    const second = await auth.refresh(first.refreshToken);

    expect(second.refreshToken).not.toEqual(first.refreshToken);
    expect(second.accessToken).toBeTruthy();

    const rows = prisma.refreshTokens;
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.revokedAt !== null)).toHaveLength(1);
  });

  it('reuse of a rotated refresh token revokes the whole family', async () => {
    const first = await auth.register('frank@example.com', 'password123');
    const second = await auth.refresh(first.refreshToken);

    // Attacker (or buggy client) replays the already-rotated token.
    await expect(auth.refresh(first.refreshToken)).rejects.toMatchObject({
      status: 401,
      code: 'REFRESH_TOKEN_REUSED',
    });

    // The legitimately rotated token is now dead too (family revoked).
    await expect(auth.refresh(second.refreshToken)).rejects.toMatchObject({
      status: 401,
    });
    const active = prisma.refreshTokens.filter((r) => r.revokedAt === null);
    expect(active).toHaveLength(0);
  });

  it('refresh rejects garbage and cross-secret tokens (401)', async () => {
    await expect(auth.refresh('garbage')).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_REFRESH_TOKEN',
    });
    const jwt = new JwtService({});
    const foreign = await jwt.signAsync(
      { sub: 'x', jti: 'y' },
      { secret: 'unit-test-access-secret-0123456789', expiresIn: 60 },
    );
    await expect(auth.refresh(foreign)).rejects.toMatchObject({ status: 401 });
  });

  it('logout revokes the presented token and is idempotent', async () => {
    const tokens = await auth.register('gina@example.com', 'password123');
    await auth.logout(tokens.refreshToken);
    await expect(auth.refresh(tokens.refreshToken)).rejects.toMatchObject({
      status: 401,
    });
    // Second logout with the same (now revoked) token still succeeds.
    await expect(auth.logout(tokens.refreshToken)).resolves.toBeUndefined();
    // Garbage tokens are fine too.
    await expect(auth.logout('garbage')).resolves.toBeUndefined();
  });
});
