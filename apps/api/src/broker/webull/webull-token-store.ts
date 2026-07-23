import { Injectable, Logger } from '@nestjs/common';
import { BrokerProvider, TradingMode } from '@0dtetrader/shared-types';
import { CryptoService } from '../../credentials/crypto.service';
import { PrismaService } from '../../prisma/prisma.service';

/** Persisted shape of a Webull access token (mirror of the client's cache). */
export interface PersistedWebullToken {
  token: string;
  /** epoch ms */
  expiresAt: number;
  /** NORMAL | PENDING */
  status: string;
}

/** Per-(user, environment) view handed to a WebullClient. */
export interface ScopedTokenStore {
  load(): Promise<PersistedWebullToken | null>;
  save(token: PersistedWebullToken): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Encrypted-at-rest persistence for Webull OpenAPI access tokens, per the
 * official guidance to store and reuse tokens (the SDK writes conf/token.txt).
 * Without this, every backend restart re-created a token — and every create
 * on production triggers an SMS 2FA approval in the user's Webull app.
 *
 * Store failures are logged and swallowed: persistence is an optimization,
 * never a reason to fail a trading or market-data call.
 */
@Injectable()
export class WebullTokenStore {
  private readonly logger = new Logger(WebullTokenStore.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  scopedTo(userId: string, provider: BrokerProvider, environment: TradingMode): ScopedTokenStore {
    return {
      load: async () => {
        try {
          const row = await this.prisma.brokerApiToken.findUnique({
            where: { userId_provider_environment: { userId, provider, environment } },
          });
          if (!row) return null;
          return {
            token: this.crypto.decrypt(row.encToken),
            expiresAt: row.expiresAt.getTime(),
            status: row.status,
          };
        } catch (err) {
          this.logger.warn(
            `Token load failed (${provider}/${environment}): ${(err as Error).message}`,
          );
          return null;
        }
      },
      save: async (token) => {
        try {
          const encToken = this.crypto.encrypt(token.token);
          const data = {
            encToken,
            expiresAt: new Date(token.expiresAt),
            status: token.status,
          };
          await this.prisma.brokerApiToken.upsert({
            where: { userId_provider_environment: { userId, provider, environment } },
            create: { userId, provider, environment, ...data },
            update: data,
          });
        } catch (err) {
          this.logger.warn(
            `Token save failed (${provider}/${environment}): ${(err as Error).message}`,
          );
        }
      },
      clear: async () => {
        try {
          await this.prisma.brokerApiToken.deleteMany({
            where: { userId: userId, provider, environment },
          });
        } catch (err) {
          this.logger.warn(
            `Token clear failed (${provider}/${environment}): ${(err as Error).message}`,
          );
        }
      },
    };
  }
}
