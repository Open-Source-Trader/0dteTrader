import { Injectable } from '@nestjs/common';
import { WebullCredentialsInput } from '@0dtetrader/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from './crypto.service';

/**
 * Persists Webull credentials encrypted at rest. Plaintext only exists in
 * memory for the duration of the request and is never logged (the logger
 * redacts appKey/appSecret/accountId). Credentials are never returned by any
 * endpoint (docs/API-SPEC.md).
 */
@Injectable()
export class CredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async save(userId: string, input: WebullCredentialsInput): Promise<void> {
    const encAppKey = this.crypto.encrypt(input.appKey);
    const encAppSecret = this.crypto.encrypt(input.appSecret);
    const encAccountId = this.crypto.encrypt(input.accountId);

    await this.prisma.webullCredential.upsert({
      where: { userId },
      create: { userId, encAppKey, encAppSecret, encAccountId },
      update: { encAppKey, encAppSecret, encAccountId },
    });
  }

  async remove(userId: string): Promise<void> {
    try {
      await this.prisma.webullCredential.delete({ where: { userId } });
    } catch {
      // Already absent — DELETE is idempotent.
    }
  }

  /**
   * Returns the decrypted credentials for a broker call. Plaintext stays in
   * memory only; callers must not log it.
   */
  async getDecrypted(userId: string): Promise<WebullCredentialsInput | null> {
    const row = await this.prisma.webullCredential.findUnique({
      where: { userId },
    });
    if (!row) return null;
    return {
      appKey: this.crypto.decrypt(row.encAppKey),
      appSecret: this.crypto.decrypt(row.encAppSecret),
      accountId: this.crypto.decrypt(row.encAccountId),
    };
  }
}
