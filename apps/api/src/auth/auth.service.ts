import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import { AuthTokens } from '@0dtetrader/shared-types';
import { errors, isUniqueViolation } from '../common/api-exception';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './password.service';

/**
 * Register/login/refresh/logout per docs/API-SPEC.md.
 * - Access JWT: 15 min (JWT_ACCESS_TTL), payload { sub } only.
 * - Refresh JWT: 14 days (JWT_REFRESH_TTL), payload { sub, jti }; only its
 *   SHA-256 hash is stored. Every use rotates the pair. Presenting a token
 *   whose DB row is already revoked is treated as reuse: the user's whole
 *   token family is revoked (docs/SECURITY.md §3).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async register(email: string, password: string): Promise<AuthTokens> {
    const normalized = this.normalizeEmail(email);
    const existing = await this.prisma.user.findUnique({
      where: { email: normalized },
    });
    if (existing) {
      throw errors.conflict('EMAIL_TAKEN', 'Email is already registered');
    }

    const passwordHash = await this.passwords.hash(password);
    let user;
    try {
      user = await this.prisma.user.create({
        data: { email: normalized, passwordHash },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw errors.conflict('EMAIL_TAKEN', 'Email is already registered');
      }
      throw err;
    }
    return this.issueTokens(user.id);
  }

  async login(email: string, password: string): Promise<AuthTokens> {
    const user = await this.prisma.user.findUnique({
      where: { email: this.normalizeEmail(email) },
    });
    if (!user || !(await this.passwords.verify(user.passwordHash, password))) {
      throw errors.unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
    }
    return this.issueTokens(user.id);
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const payload = await this.verifyRefreshJwt(refreshToken);
    const tokenHash = this.hashToken(refreshToken);
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (!row || row.userId !== payload.sub) {
      throw errors.unauthorized('INVALID_REFRESH_TOKEN', 'Invalid refresh token');
    }

    if (row.revokedAt) {
      // Reuse of a rotated token — possible theft: revoke the whole family.
      await this.revokeAllForUser(row.userId);
      throw errors.unauthorized(
        'REFRESH_TOKEN_REUSED',
        'Refresh token was already used; all sessions for this user have been revoked',
      );
    }

    if (row.expiresAt.getTime() <= Date.now()) {
      throw errors.unauthorized('INVALID_REFRESH_TOKEN', 'Refresh token expired');
    }

    // Rotate atomically: only the first concurrent request to revoke the row
    // wins; the loser sees count 0, which means the token was just used —
    // treat it exactly like reuse (family revoke), not a second rotation.
    const revoked = await this.prisma.refreshToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count === 0) {
      await this.revokeAllForUser(row.userId);
      throw errors.unauthorized(
        'REFRESH_TOKEN_REUSED',
        'Refresh token was already used; all sessions for this user have been revoked',
      );
    }
    return this.issueTokens(row.userId);
  }

  async logout(refreshToken: string): Promise<void> {
    // Best-effort revocation; logout is idempotent and always succeeds.
    try {
      await this.verifyRefreshJwt(refreshToken);
      const tokenHash = this.hashToken(refreshToken);
      await this.prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } catch {
      // Malformed token — nothing to revoke.
    }
  }

  // -------------------------------------------------------------------------

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async verifyRefreshJwt(token: string): Promise<{ sub: string }> {
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token, {
        secret: this.config.getOrThrow<string>('jwt.refreshSecret'),
      });
      if (!payload.sub) throw new Error('missing sub');
      return payload;
    } catch {
      throw errors.unauthorized('INVALID_REFRESH_TOKEN', 'Invalid refresh token');
    }
  }

  private async issueTokens(userId: string): Promise<AuthTokens> {
    const accessTtl = this.config.getOrThrow<number>('jwt.accessTtl');
    const refreshTtl = this.config.getOrThrow<number>('jwt.refreshTtl');

    const accessToken = await this.jwt.signAsync(
      { sub: userId },
      {
        secret: this.config.getOrThrow<string>('jwt.accessSecret'),
        expiresIn: accessTtl,
      },
    );

    const refreshToken = await this.jwt.signAsync(
      { sub: userId, jti: randomUUID() },
      {
        secret: this.config.getOrThrow<string>('jwt.refreshSecret'),
        expiresIn: refreshTtl,
      },
    );

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: new Date(Date.now() + refreshTtl * 1000),
      },
    });

    return { accessToken, refreshToken, expiresIn: accessTtl };
  }

  private async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
