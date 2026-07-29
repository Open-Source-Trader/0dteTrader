import { Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';

/**
 * Rate limits are tracked per (IP, user) pair, not user alone — a global
 * guard runs before JwtAuthGuard (APP_GUARD order in app.module.ts), so
 * req.user is never populated here. Decoding the bearer token ourselves
 * (unverified: this is only for bucketing, not authorization — JwtAuthGuard
 * still verifies it afterward) resolves the user without depending on guard
 * order.
 *
 * IP stays part of the key because an unverified decode trusts whatever
 * `sub` the token claims: keying on `sub` alone would let a request with a
 * forged token rotate identities to dodge its own limit. Keeping IP in the
 * key means that trick still hits the same IP-scoped bucket; it only fixes
 * the real problem (several distinct users sharing one IP, or one user
 * moving between IPs, both undercounted today).
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    @Inject(JwtService) private readonly jwt: JwtService,
  ) {
    super(options, storageService, reflector);
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const ip = req.ip ?? 'unknown';
    const header = req.headers?.authorization;
    const token =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) return ip;
    const userId = this.decodeUserId(token);
    return userId ? `${ip}:${userId}` : ip;
  }

  private decodeUserId(token: string): string | null {
    try {
      const payload = this.jwt.decode<{ sub?: unknown }>(token);
      return typeof payload?.sub === 'string' && payload.sub.length > 0 ? payload.sub : null;
    } catch {
      return null;
    }
  }
}
