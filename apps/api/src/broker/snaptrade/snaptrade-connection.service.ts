import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CredentialsService } from '../../credentials/credentials.service';
import { SnapTradeClient } from './snaptrade-client';
import { SnapTradeSecrets, TradingMode } from '@0dtetrader/shared-types';
import { brokerErrors } from '../../common/broker-error';

/** Locally persisted SnapTrade connection metadata. */
export interface SnapTradeConnectionRecord {
  connectionId: string;
  brokerage: string;
  name: string;
  type: string;
  status: 'active' | 'broken' | 'pending';
  accountIds: string[];
  selectedAccountId: string | null;
  createdAt: Date;
}

type BrokerConnectionDelegate = {
  findMany(args: { where: { userId: string; provider: string; environment: string } }): Promise<
    Array<{
      connectionId: string;
      accountIds: string[];
      selectedAccountId: string | null;
      createdAt: Date;
    }>
  >;
  deleteMany(args: {
    where: { userId: string; provider: string; environment: string; connectionId: string };
  }): Promise<unknown>;
  upsert(args: {
    where: {
      userId_provider_environment: { userId: string; provider: string; environment: string };
    };
    create: {
      userId: string;
      provider: string;
      environment: string;
      connectionId: string;
      accountIds: string[];
      selectedAccountId: string;
      status: string;
    };
    update: {
      connectionId: string;
      accountIds: { push: string };
      selectedAccountId: string;
    };
  }): Promise<unknown>;
};

/**
 * SnapTrade connection lifecycle: authorize (Connection Portal), list
 * connections, list accounts, delete, and reconnect. All mutations are
 * per-user and scoped to the user's selected trading mode (live / practice).
 *
 * **Personal API key model:** each user brings their own SnapTrade Personal
 * `clientId`/`consumerKey` (entered in Profile, same as Alpaca's API key —
 * see `CredentialsService`). There is no server-minted SnapTrade identity:
 * we never call `registerUser`, never hold a `userId`/`userSecret`, and the
 * operator is never the SnapTrade customer of record for any user's data.
 */
@Injectable()
export class SnapTradeConnectionService {
  constructor(
    private readonly client: SnapTradeClient,
    private readonly credentials: CredentialsService,
    private readonly prisma: PrismaService,
  ) {}

  private get brokerConnections() {
    return this.prisma as PrismaService & { brokerConnection: BrokerConnectionDelegate };
  }

  /**
   * Return a Connection Portal redirect URL. The client opens this URL
   * (in-app browser / popup) so the user can OAuth-connect their brokerage.
   */
  async authorize(
    userId: string,
    mode: TradingMode,
    opts?: {
      brokerage?: string;
      immediateRedirect?: boolean;
      customRedirect?: string;
      reconnect?: string;
      connectionType?: 'read' | 'trade' | 'trade-if-available';
    },
  ): Promise<{ redirectUrl: string }> {
    const { clientId, consumerKey } = await this.credentialsFor(userId, mode);
    return this.client.authorize(mode, clientId, consumerKey, opts);
  }

  /**
   * List all SnapTrade connections for the user, merged with locally
   * persisted `BrokerConnection` rows.
   */
  async listConnections(userId: string, mode: TradingMode): Promise<SnapTradeConnectionRecord[]> {
    const { clientId, consumerKey } = await this.credentialsFor(userId, mode);
    const remote = await this.client.listConnections(mode, clientId, consumerKey);
    const local = await this.brokerConnections.brokerConnection.findMany({
      where: { userId, provider: 'snaptrade', environment: mode },
    });
    const localMap = new Map(
      local.map(
        (c: {
          connectionId: string;
          accountIds: string[];
          selectedAccountId: string | null;
          createdAt: Date;
        }) => [c.connectionId, c],
      ),
    );

    return remote.map((auth) => {
      const existing = localMap.get(auth.id ?? '');
      return {
        connectionId: auth.id ?? '',
        brokerage: auth.brokerage?.name ?? 'unknown',
        name: auth.name ?? '',
        type: auth.type ?? 'read',
        status: auth.status === 'DISABLED' ? 'broken' : 'active',
        accountIds: existing?.accountIds ?? [],
        selectedAccountId: existing?.selectedAccountId ?? null,
        createdAt: existing?.createdAt ?? new Date(),
      } satisfies SnapTradeConnectionRecord;
    });
  }

  /**
   * List accounts for a specific connection.
   */
  async listAccounts(
    userId: string,
    mode: TradingMode,
    connectionId: string,
  ): Promise<Array<{ accountId: string; name: string }>> {
    const { clientId, consumerKey } = await this.credentialsFor(userId, mode);
    const accounts = await this.client.listConnectionAccounts(
      mode,
      clientId,
      consumerKey,
      connectionId,
    );
    return accounts.map((a) => ({ accountId: a.id ?? '', name: a.name ?? '' }));
  }

  /**
   * Delete a SnapTrade connection (both remote and local).
   */
  async deleteConnection(userId: string, mode: TradingMode, connectionId: string): Promise<void> {
    const { clientId, consumerKey } = await this.credentialsFor(userId, mode);
    await this.client.deleteConnection(mode, clientId, consumerKey, connectionId);
    await this.brokerConnections.brokerConnection.deleteMany({
      where: { userId, provider: 'snaptrade', environment: mode, connectionId },
    });
  }

  /**
   * Return a fresh Connection Portal URL for a broken/expired connection.
   */
  async reconnect(
    userId: string,
    mode: TradingMode,
    connectionId: string,
  ): Promise<{ redirectUrl: string }> {
    const { clientId, consumerKey } = await this.credentialsFor(userId, mode);
    return this.client.authorize(mode, clientId, consumerKey, { reconnect: connectionId });
  }

  /**
   * Persist the user's selected trading account for a connection.
   */
  async selectAccount(
    userId: string,
    mode: TradingMode,
    connectionId: string,
    accountId: string,
  ): Promise<void> {
    await this.brokerConnections.brokerConnection.upsert({
      where: { userId_provider_environment: { userId, provider: 'snaptrade', environment: mode } },
      create: {
        userId,
        provider: 'snaptrade',
        environment: mode,
        connectionId,
        accountIds: [accountId],
        selectedAccountId: accountId,
        status: 'active',
      },
      update: {
        connectionId,
        accountIds: { push: accountId },
        selectedAccountId: accountId,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Resolve the user's own stored SnapTrade Personal client ID/consumer key.
   * Throws if the user hasn't entered one yet — there is no identity to mint
   * on their behalf under the Personal API key model.
   */
  private async credentialsFor(userId: string, mode: TradingMode): Promise<SnapTradeSecrets> {
    const stored = await this.credentials.getDecrypted(userId, 'snaptrade', mode);
    if (!stored) {
      throw brokerErrors.authFailed(
        mode === 'practice'
          ? 'No SnapTrade practice credentials — save your Personal client ID/consumer key in Profile first'
          : 'No SnapTrade credentials — save your Personal client ID/consumer key in Profile first',
      );
    }
    if (stored.provider !== 'snaptrade') {
      throw brokerErrors.authFailed('Stored credentials are not SnapTrade credentials');
    }
    return stored;
  }
}
