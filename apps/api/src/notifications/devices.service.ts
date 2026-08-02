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

  /** Scoped to the caller: deleting someone else's token is a no-op. */
  async unregister(userId: string, token: string): Promise<void> {
    await this.prisma.deviceToken.deleteMany({ where: { userId, token } });
  }

  listForUser(userId: string): Promise<{ token: string; platform: string }[]> {
    return this.prisma.deviceToken.findMany({ where: { userId } });
  }

  /** Removes a token APNs reported dead, whoever owns it. */
  async prune(token: string): Promise<void> {
    await this.prisma.deviceToken.deleteMany({ where: { token } });
  }
}
