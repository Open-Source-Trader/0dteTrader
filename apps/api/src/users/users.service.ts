import { Injectable } from '@nestjs/common';
import { BrokerProvider, Me, TradingMode, WebullSecrets } from '@0dtetrader/shared-types';
import { errors } from '../common/api-exception';
import { CryptoService } from '../credentials/crypto.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /** Webull credential presence + account id for /me. The provider-agnostic
   *  `broker_credentials` table is authoritative; falls back to the legacy
   *  `webull_credentials` row during the P1 migration window. */
  private async webullCred(
    userId: string,
    environment: TradingMode,
  ): Promise<{ exists: boolean; accountId: string | null }> {
    const broker = await this.prisma.brokerCredential.findUnique({
      where: { userId_provider_environment: { userId, provider: 'webull', environment } },
    });
    if (broker) {
      try {
        const secrets = JSON.parse(this.crypto.decrypt(broker.encSecrets)) as WebullSecrets;
        return { exists: true, accountId: secrets.accountId ?? null };
      } catch {
        return { exists: true, accountId: null };
      }
    }
    const legacy = await this.prisma.webullCredential.findUnique({
      where: { userId_environment: { userId, environment } },
    });
    if (legacy) {
      return {
        exists: true,
        accountId: legacy.encAccountId ? this.crypto.decrypt(legacy.encAccountId) : null,
      };
    }
    return { exists: false, accountId: null };
  }

  /** Alpaca credential presence for /me. Alpaca secrets carry no
   *  account id (its v2 API is key-scoped), so accountId is null. */
  private async alpacaCred(
    userId: string,
    environment: TradingMode,
  ): Promise<{ exists: boolean; accountId: string | null }> {
    const broker = await this.prisma.brokerCredential.findUnique({
      where: { userId_provider_environment: { userId, provider: 'alpaca', environment } },
    });
    return { exists: Boolean(broker), accountId: null };
  }

  private async snapTradeCred(userId: string): Promise<{
    exists: boolean;
    accountId: string | null;
    practiceAccountId: string | null;
  }> {
    const connections = await this.prisma.brokerConnection.findMany({
      where: { userId, provider: 'snaptrade' },
    });
    const active = connections.find((connection) => connection.status === 'active') ?? null;
    const accountId = active?.selectedAccountId ?? connections[0]?.selectedAccountId ?? null;
    return {
      exists: Boolean(active),
      accountId,
      practiceAccountId: accountId,
    };
  }

  async getMe(userId: string): Promise<Me> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw errors.unauthorized('USER_NOT_FOUND', 'User no longer exists');
    }
    const [live, practice, alpacaLive, alpacaPractice, snaptrade] = await Promise.all([
      this.webullCred(userId, 'live'),
      this.webullCred(userId, 'practice'),
      this.alpacaCred(userId, 'live'),
      this.alpacaCred(userId, 'practice'),
      this.snapTradeCred(userId),
    ]);
    return {
      id: user.id,
      email: user.email,
      tradingDisabled: user.tradingDisabled,
      tradingMode: user.tradingMode as TradingMode,
      tradingProvider: user.tradingProvider as BrokerProvider,
      webullConfigured: live.exists,
      webullPracticeConfigured: practice.exists,
      // The account id is an identifier, not a secret — surfacing it lets the
      // user confirm which account was auto-discovered via account/list.
      webullAccountId: live.accountId,
      webullPracticeAccountId: practice.accountId,
      // Alpaca v2 is key-scoped: no account id is stored. The flags
      // let the app show whether the user has saved Alpaca credentials.
      alpacaConfigured: alpacaLive.exists,
      alpacaPracticeConfigured: alpacaPractice.exists,
      alpacaAccountId: alpacaLive.accountId,
      alpacaPracticeAccountId: alpacaPractice.accountId,
      snaptradeConfigured: snaptrade.exists,
      snaptradePracticeConfigured: snaptrade.exists,
      snaptradeAccountId: snaptrade.accountId,
      snaptradePracticeAccountId: snaptrade.practiceAccountId,
    };
  }

  async setTradingMode(userId: string, mode: TradingMode): Promise<Me> {
    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: { tradingMode: mode },
      });
    } catch (err) {
      // P2025: the user was deleted after their JWT was issued — surface the
      // same USER_NOT_FOUND as getMe instead of a 500.
      if ((err as { code?: string }).code === 'P2025') {
        throw errors.unauthorized('USER_NOT_FOUND', 'User no longer exists');
      }
      throw err;
    }
    return this.getMe(userId);
  }

  async setTradingProvider(userId: string, provider: BrokerProvider): Promise<Me> {
    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: { tradingProvider: provider },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2025') {
        throw errors.unauthorized('USER_NOT_FOUND', 'User no longer exists');
      }
      throw err;
    }
    return this.getMe(userId);
  }
}
