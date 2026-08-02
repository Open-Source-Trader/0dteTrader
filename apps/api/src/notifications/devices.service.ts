import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The push-notification device registry. `token` is globally unique, so
 * registering is an upsert that moves the token to the registering account —
 * a device that changed users must only ever notify its current owner.
 */
@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService) {}

  async register(userId: string, token: string, platform: string): Promise<void> {
    await this.prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform },
    });
  }

  /**
   * Possession of the token authorizes removal, whoever owns the row: the
   * holder of the device could re-register it to themselves anyway (the
   * upsert moves it), and the next account signing in on a device must be
   * able to clear a registration a session expiry stranded — the previous
   * account's credentials are gone by then. Tokens are 64+ unguessable hex
   * chars, so this is a capability, not an enumeration surface.
   */
  async unregister(token: string): Promise<void> {
    await this.prune(token);
  }

  listForUser(userId: string): Promise<{ token: string; platform: string }[]> {
    return this.prisma.deviceToken.findMany({ where: { userId } });
  }

  /** Removes a token APNs reported dead, whoever owns it. */
  async prune(token: string): Promise<void> {
    await this.prisma.deviceToken.deleteMany({ where: { token } });
  }
}
