import { Injectable } from '@nestjs/common';
import {
  AlpacaCredentialsInput,
  BrokerCredentialsInput,
  BrokerProvider,
  BrokerSecrets,
  TradingMode,
  WebullCredentialsInput,
  WebullSecrets,
} from '@0dtetrader/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from './crypto.service';

const WEBULL_PROVIDER: BrokerProvider = 'webull';

/**
 * Persists broker credentials encrypted at rest in the provider-agnostic
 * `broker_credentials` table. `encSecrets` is one AES-256-GCM blob of the
 * provider-specific secret JSON (Webull: {appKey, appSecret, accountId};
 * Alpaca: {apiKey, apiSecret}). Plaintext only exists in memory for the
 * duration of the request and is never logged. One set per (user, provider,
 * environment) (live / practice).
 *
 * A temporary `ensureMigrated` shim lazily copies any legacy
 * `webull_credentials` row into `broker_credentials` on first read, so the P1
 * schema change is non-breaking. Remove it once all environments are
 * backfilled.
 */
@Injectable()
export class CredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async save(
    userId: string,
    input: BrokerCredentialsInput,
    environment: TradingMode = 'live',
  ): Promise<void> {
    const provider = input.provider ?? WEBULL_PROVIDER;
    const secrets = this.toSecrets(input, provider);
    await this.upsertSecrets(userId, provider, environment, secrets);
  }

  /** Persist an account id discovered out-of-band (Webull: account/list). */
  async saveDiscoveredAccountId(
    userId: string,
    provider: BrokerProvider,
    environment: TradingMode,
    accountId: string,
  ): Promise<void> {
    await this.ensureMigrated(userId, environment);
    const row = await this.prisma.brokerCredential.findUnique({
      where: { userId_provider_environment: { userId, provider, environment } },
    });
    if (!row) return;
    const secrets = this.decryptSecrets(row.encSecrets);
    if (secrets.provider !== 'webull') return;
    const updated: WebullSecrets = { ...(secrets as WebullSecrets), accountId };
    await this.prisma.brokerCredential.update({
      where: { userId_provider_environment: { userId, provider, environment } },
      data: { encSecrets: this.crypto.encrypt(JSON.stringify(updated)) },
    });
  }

  /**
   * Materialize the server's built-in Webull practice fallback as a stored
   * `broker_credentials` row (idempotent: only when no row exists). This lets
   * the discovered practice account id persist across token-cache misses /
   * restarts (bug 3) and lets `/me` report `webullPracticeConfigured` for
   * fallback users once they trade in practice (bug 2). Without it, the
   * fallback lives only in the gateway's config and is never written, so the
   * discovered account id is re-discovered on every cache miss / restart.
   */
  async ensureWebullPracticeStored(
    userId: string,
    creds: { appKey: string; appSecret: string; accountId?: string },
  ): Promise<void> {
    const environment: TradingMode = 'practice';
    const existing = await this.prisma.brokerCredential.findUnique({
      where: { userId_provider_environment: { userId, provider: WEBULL_PROVIDER, environment } },
    });
    if (existing) return;
    const secrets: WebullSecrets = {
      provider: 'webull',
      appKey: creds.appKey,
      appSecret: creds.appSecret,
      accountId: creds.accountId,
    };
    await this.upsertSecrets(userId, WEBULL_PROVIDER, environment, secrets);
  }

  async remove(
    userId: string,
    provider: BrokerProvider = WEBULL_PROVIDER,
    environment: TradingMode = 'live',
  ): Promise<void> {
    try {
      await this.prisma.brokerCredential.delete({
        where: { userId_provider_environment: { userId, provider, environment } },
      });
    } catch (err) {
      // Only P2025 (row already absent) is idempotent — anything else (DB
      // outage, constraint error) must surface, or the user is told their
      // credentials were deleted when they weren't.
      if ((err as { code?: string }).code !== 'P2025') throw err;
    }
  }

  /**
   * Returns the decrypted secrets for a broker call. Plaintext stays in
   * memory only; callers must not log it. Lazily migrates a legacy
   * `webull_credentials` row on first read.
   */
  async getDecrypted(
    userId: string,
    provider: BrokerProvider = WEBULL_PROVIDER,
    environment: TradingMode = 'live',
  ): Promise<BrokerSecrets | null> {
    await this.ensureMigrated(userId, environment);
    const row = await this.prisma.brokerCredential.findUnique({
      where: { userId_provider_environment: { userId, provider, environment } },
    });
    if (!row) return null;
    return this.decryptSecrets(row.encSecrets);
  }

  private decryptSecrets(blob: Uint8Array): BrokerSecrets {
    try {
      return JSON.parse(this.crypto.decrypt(blob)) as BrokerSecrets;
    } catch {
      throw new Error('Corrupt broker credential blob — re-save your broker credentials');
    }
  }

  private toSecrets(input: BrokerCredentialsInput, provider: BrokerProvider): BrokerSecrets {
    if (provider === 'alpaca') {
      const a = input as AlpacaCredentialsInput;
      return { provider: 'alpaca', apiKey: a.apiKey, apiSecret: a.apiSecret };
    }
    const w = input as WebullCredentialsInput;
    return { provider: 'webull', appKey: w.appKey, appSecret: w.appSecret, accountId: w.accountId };
  }

  private async upsertSecrets(
    userId: string,
    provider: BrokerProvider,
    environment: TradingMode,
    secrets: BrokerSecrets,
  ): Promise<void> {
    const encSecrets = this.crypto.encrypt(JSON.stringify(secrets));
    await this.prisma.brokerCredential.upsert({
      where: { userId_provider_environment: { userId, provider, environment } },
      create: { userId, provider, environment, encSecrets },
      update: { encSecrets },
    });
  }

  /** Lazily copy a legacy `webull_credentials` row into `broker_credentials`.
   *  Idempotent; leaves the legacy row intact. Transition shim — remove once
   *  all environments have been backfilled. */
  private async ensureMigrated(userId: string, environment: TradingMode): Promise<void> {
    const existing = await this.prisma.brokerCredential.findUnique({
      where: { userId_provider_environment: { userId, provider: WEBULL_PROVIDER, environment } },
    });
    if (existing) return;
    const legacy = await this.prisma.webullCredential.findUnique({
      where: { userId_environment: { userId, environment } },
    });
    if (!legacy) return;
    const secrets: WebullSecrets = {
      provider: 'webull',
      appKey: this.crypto.decrypt(legacy.encAppKey),
      appSecret: this.crypto.decrypt(legacy.encAppSecret),
      accountId: legacy.encAccountId ? this.crypto.decrypt(legacy.encAccountId) : undefined,
    };
    await this.upsertSecrets(userId, WEBULL_PROVIDER, environment, secrets);
  }
}
