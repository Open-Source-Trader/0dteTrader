import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The push-notification device registry. `token` is globally unique, so
 * registering is an upsert that moves the token to the registering account —
 * a device that changed users must only ever notify its current owner.
 */
@Injectable()
export class DevicesService {
  private static readonly MAX_DEVICES_PER_USER = 10;
  private static readonly TOKEN_TRANSACTION_TIMEOUT_MS = 30_000;
  private static readonly TRANSACTION_ATTEMPTS = 3;

  constructor(private readonly prisma: PrismaService) {}

  async register(userId: string, token: string, platform: string): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.prisma.$transaction(
          async (database) => {
            // Serialize ownership changes with sends. Without the shared lock a
            // worker can validate owner A, then registration can move the token to B
            // in the gap immediately before APNs receives A's private alert.
            await database.$executeRaw(
              Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${token}, 0))`,
            );

            const existing = await database.deviceToken.findMany({ where: { token } });
            // Cap cleanup can delete any token owned by the registering user.
            // A cross-account swap otherwise deadlocks as follows:
            //   A holds token A / row A and waits deleting row B;
            //   B holds token B / row B and waits deleting row A.
            // Lock both the prior and destination owners, sorted, BEFORE any
            // upsert takes a token-row lock. Every registration that could
            // clean either user's cap therefore serializes before row writes.
            const affectedUsers = Array.from(
              new Set([userId, existing[0]?.userId].filter((id): id is string => Boolean(id))),
            ).sort();
            for (const affectedUserId of affectedUsers) {
              await database.$executeRaw(
                Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`push-device-user:${affectedUserId}`}, 0))`,
              );
            }
            await database.deviceToken.upsert({
              where: { token },
              create: { userId, token, platform },
              update: { userId, platform },
            });

            // A global token can move between accounts. Retrying an outbox row that
            // was created for its old owner would disclose that user's trade, and a
            // send-time owner check alone misses A -> B -> A moves. Supersede every
            // old-owner row in the same transaction that changes ownership.
            const stale = await database.pushDelivery.findMany({
              where: {
                deviceToken: token,
                status: { in: ['pending', 'retry', 'leased'] },
              },
            });
            for (const owner of new Set(
              stale.map((delivery) => delivery.userId).filter((ownerId) => ownerId !== userId),
            )) {
              await database.pushDelivery.updateMany({
                where: {
                  userId: owner,
                  deviceToken: token,
                  status: { in: ['pending', 'retry', 'leased'] },
                },
                data: {
                  status: 'dead',
                  leaseOwnerId: null,
                  leaseExpiresAt: null,
                  lastError: 'device token ownership changed',
                },
              });
            }

            const devices = await database.deviceToken.findMany({
              where: { userId },
            });
            devices.sort((left, right) => {
              // Always retain the token whose registration this call just committed,
              // even when several rows share the database's millisecond timestamp.
              if (left.token === token) return -1;
              if (right.token === token) return 1;
              const byUpdate = right.updatedAt.getTime() - left.updatedAt.getTime();
              return byUpdate !== 0 ? byUpdate : right.token.localeCompare(left.token);
            });
            const overflow = devices.slice(DevicesService.MAX_DEVICES_PER_USER);
            if (overflow.length > 0) {
              const overflowTokens = overflow.map((device) => device.token);
              await database.pushDelivery.updateMany({
                where: {
                  userId,
                  deviceToken: { in: overflowTokens },
                  status: { in: ['pending', 'retry', 'leased'] },
                },
                data: {
                  status: 'dead',
                  leaseOwnerId: null,
                  leaseExpiresAt: null,
                  lastError: 'device removed by registration limit',
                },
              });
              await database.deviceToken.deleteMany({
                // A token may have moved to another user after this stale list read.
                // Keep the owner predicate so cleanup cannot delete the new owner's
                // freshly registered device.
                where: { userId, token: { in: overflowTokens } },
              });
            }
          },
          { timeout: DevicesService.TOKEN_TRANSACTION_TIMEOUT_MS },
        );
        return;
      } catch (error) {
        if (
          attempt >= DevicesService.TRANSACTION_ATTEMPTS ||
          !DevicesService.retryableTransactionError(error)
        ) {
          throw error;
        }
      }
    }
  }

  private static retryableTransactionError(error: unknown): boolean {
    const failure = error as { code?: string; meta?: { code?: string } };
    return (
      failure.code === 'P2034' ||
      failure.code === '40P01' ||
      failure.code === '40001' ||
      failure.meta?.code === '40P01' ||
      failure.meta?.code === '40001'
    );
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
    await this.prisma.$transaction(
      async (database) => {
        await database.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${token}, 0))`,
        );
        await database.pushDelivery.updateMany({
          where: { deviceToken: token, status: { in: ['pending', 'retry', 'leased'] } },
          data: {
            status: 'dead',
            leaseOwnerId: null,
            leaseExpiresAt: null,
            lastError: 'device token unregistered',
          },
        });
        await database.deviceToken.deleteMany({ where: { token } });
      },
      { timeout: DevicesService.TOKEN_TRANSACTION_TIMEOUT_MS },
    );
  }
}
