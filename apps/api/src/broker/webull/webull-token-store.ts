import { Injectable, Logger } from '@nestjs/common';
import { TradingMode } from '@0dtetrader/shared-types';
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

  scopedTo(userId: string, environment: TradingMode): ScopedTokenStore {
    return {
      load: async () => {
        try {
          const row = await this.prisma.webullApiToken.findUnique({
            where: { userId_environment: { userId, environment } },
          });
          if (!row) return null;
          return {
            token: this.crypto.decrypt(row.encToken),
            expiresAt: row.expiresAt.getTime(),
            status: row.status,
          };
        } catch (err) {
          this.logger.warn(`Webull token load failed (${environment}): ${(err as Error).message}`);
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
          await this.prisma.webullApiToken.upsert({
            where: { userId_environment: { userId, environment } },
            create: { userId, environment, ...data },
            update: data,
          });
        } catch (err) {
          this.logger.warn(`Webull token save failed (${environment}): ${(err as Error).message}`);
        }
      },
      clear: async () => {
        try {
          await this.prisma.webullApiToken.deleteMany({
            where: { userId, environment },
          });
        } catch (err) {
          this.logger.warn(`Webull token clear failed (${environment}): ${(err as Error).message}`);
        }
      },
    };
  }
}
