import { Injectable } from '@nestjs/common';
import { TradingMode, WebullCredentialsInput } from '@0dtetrader/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from './crypto.service';

/**
 * Persists Webull credentials encrypted at rest. Plaintext only exists in
 * memory for the duration of the request and is never logged (the logger
 * redacts appKey/appSecret/accountId). Credentials are never returned by any
 * endpoint (docs/API-SPEC.md). Each user can store one set per environment
 * (live / practice).
 */
@Injectable()
export class CredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async save(
    userId: string,
    input: WebullCredentialsInput,
    environment: TradingMode = 'live',
  ): Promise<void> {
    const encAppKey = this.crypto.encrypt(input.appKey);
    const encAppSecret = this.crypto.encrypt(input.appSecret);
    // No manual account id: store null and let the gateway discover it via
    // GET /openapi/account/list. Re-saving key/secret clears a previously
    // discovered id on purpose — it may belong to the old application.
    const encAccountId = input.accountId ? this.crypto.encrypt(input.accountId) : null;

    await this.prisma.webullCredential.upsert({
      where: { userId_environment: { userId, environment } },
      create: { userId, environment, encAppKey, encAppSecret, encAccountId },
      update: { encAppKey, encAppSecret, encAccountId },
    });
  }

  /** Persist an account id discovered via account/list (no-op without a row —
   *  e.g. the server's built-in practice credentials have none). */
  async saveDiscoveredAccountId(
    userId: string,
    environment: TradingMode,
    accountId: string,
  ): Promise<void> {
    await this.prisma.webullCredential.updateMany({
      where: { userId, environment },
      data: { encAccountId: this.crypto.encrypt(accountId) },
    });
  }

  async remove(userId: string, environment: TradingMode = 'live'): Promise<void> {
    try {
      await this.prisma.webullCredential.delete({
        where: { userId_environment: { userId, environment } },
      });
    } catch (err) {
      // Only P2025 (row already absent) is idempotent — anything else (DB
      // outage, constraint error) must surface, or the user is told their
      // credentials were deleted when they weren't.
      if ((err as { code?: string }).code !== 'P2025') throw err;
    }
  }

  /**
   * Returns the decrypted credentials for a broker call. Plaintext stays in
   * memory only; callers must not log it.
   */
  async getDecrypted(
    userId: string,
    environment: TradingMode = 'live',
  ): Promise<WebullCredentialsInput | null> {
    const row = await this.prisma.webullCredential.findUnique({
      where: { userId_environment: { userId, environment } },
    });
    if (!row) return null;
    return {
      appKey: this.crypto.decrypt(row.encAppKey),
      appSecret: this.crypto.decrypt(row.encAppSecret),
      accountId: row.encAccountId ? this.crypto.decrypt(row.encAccountId) : undefined,
    };
  }
}
