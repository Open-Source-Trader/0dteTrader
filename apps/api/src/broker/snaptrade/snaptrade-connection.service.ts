import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CredentialsService } from '../../credentials/credentials.service';
import { SnapTradeClient } from './snaptrade-client';
import { TradingMode } from '@0dtetrader/shared-types';

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

/**
 * SnapTrade connection lifecycle: register, authorize, list connections,
 * list accounts, delete, and reconnect. All mutations are per-user and
 * scoped to the user's selected trading mode (live / practice).
 */
type BrokerConnectionDelegate = {
  findMany(args: { where: { userId: string; provider: string } }): Promise<
    Array<{
      connectionId: string;
      accountIds: string[];
      selectedAccountId: string | null;
      createdAt: Date;
    }>
  >;
  deleteMany(args: {
    where: { userId: string; provider: string; connectionId: string };
  }): Promise<unknown>;
  upsert(args: {
    where: { userId_provider: { userId: string; provider: string } };
    create: {
      userId: string;
      provider: string;
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
   * Register a new SnapTrade user (mint userId + userSecret) and persist
   * the identity encrypted in `broker_credentials`. Idempotent: if the
   * identity already exists, it is preserved.
   */
  async registerUser(
    userId: string,
    mode: TradingMode = 'live',
  ): Promise<{
    userId: string;
    userSecret: string;
  }> {
    const existing = await this.credentials.getSnapTradeIdentity(userId, mode);
    if (existing) {
      return { userId: existing.snaptradeUserId, userSecret: existing.snaptradeUserSecret };
    }
    const result = await this.client.registerUser(mode, userId);
    const userSecret = result.userSecret ?? '';
    await this.credentials.saveSnapTradeIdentity(userId, {
      provider: 'snaptrade',
      snaptradeUserId: result.userId ?? userId,
      snaptradeUserSecret: userSecret,
    });
    return { userId: result.userId ?? userId, userSecret };
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
    const identity = await this.ensureIdentity(userId, mode);
    return this.client.authorize(mode, identity.userId, identity.userSecret, opts);
  }

  /**
   * List all SnapTrade connections for the user, merged with locally
   * persisted `BrokerConnection` rows.
   */
  async listConnections(userId: string, mode: TradingMode): Promise<SnapTradeConnectionRecord[]> {
    const identity = await this.ensureIdentity(userId, mode);
    const remote = await this.client.listConnections(mode, identity.userId, identity.userSecret);
    const local = await this.brokerConnections.brokerConnection.findMany({
      where: { userId, provider: 'snaptrade' },
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
    const identity = await this.ensureIdentity(userId, mode);
    const accounts = await this.client.listConnectionAccounts(
      mode,
      identity.userId,
      identity.userSecret,
      connectionId,
    );
    return accounts.map((a) => ({ accountId: a.id ?? '', name: a.name ?? '' }));
  }

  /**
   * Delete a SnapTrade connection (both remote and local).
   */
  async deleteConnection(userId: string, mode: TradingMode, connectionId: string): Promise<void> {
    const identity = await this.ensureIdentity(userId, mode);
    await this.client.deleteConnection(mode, identity.userId, identity.userSecret, connectionId);
    await this.brokerConnections.brokerConnection.deleteMany({
      where: { userId, provider: 'snaptrade', connectionId },
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
    const identity = await this.ensureIdentity(userId, mode);
    return this.client.authorize(mode, identity.userId, identity.userSecret, {
      reconnect: connectionId,
    });
  }

  /**
   * Persist the user's selected trading account for a connection.
   */
  async selectAccount(userId: string, connectionId: string, accountId: string): Promise<void> {
    await this.brokerConnections.brokerConnection.upsert({
      where: { userId_provider: { userId, provider: 'snaptrade' } },
      create: {
        userId,
        provider: 'snaptrade',
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

  private async ensureIdentity(
    userId: string,
    mode: TradingMode,
  ): Promise<{ userId: string; userSecret: string }> {
    const identity = await this.credentials.getSnapTradeIdentity(userId, mode);
    if (!identity) {
      const created = await this.registerUser(userId, mode);
      return { userId: created.userId, userSecret: created.userSecret };
    }
    return { userId: identity.snaptradeUserId, userSecret: identity.snaptradeUserSecret };
  }
}
