import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate limits are tracked per authenticated user when the request already
 * carries one (otherwise per IP). Note APP_GUARD ordering: this guard runs
 * before JwtAuthGuard, so most requests fall back to IP tracking — acceptable
 * for v1 since each iOS client is a single user.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.user?.userId ?? req.ip ?? 'unknown';
  }
}
