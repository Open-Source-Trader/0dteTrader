import { Controller, Delete, Get, Post, Query } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '../../common/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SnapTradeConnectionService,
  SnapTradeConnectionRecord,
} from './snaptrade-connection.service';
import { TradingMode } from '@0dtetrader/shared-types';

/**
 * SnapTrade connection lifecycle endpoints.
 *
 * All routes are prefixed with `/v1/me/broker-connections/snaptrade`.
 *
 * Every route accepts an optional `?environment=live|practice` query param so
 * the caller can act on a specific environment's connection (the desktop/iOS
 * Profile screen renders independent "Live" and "Practice" cards). When
 * omitted, falls back to the user's current global `tradingMode` — this
 * preserves the behavior older clients (that don't send the param) relied on.
 */
@Controller('me/broker-connections/snaptrade')
export class SnapTradeConnectionController {
  constructor(
    private readonly connections: SnapTradeConnectionService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('environment') environment?: TradingMode,
  ): Promise<{
    connections: SnapTradeConnectionRecord[];
    accounts: Record<string, { accountId: string; name: string }[]>;
    status: { configured: boolean; selectedAccountId: string | null };
  }> {
    const mode = environment ?? (await this.tradingModeFor(user.userId));
    const connections = await this.connections.listConnections(user.userId, mode);
    const accounts: Record<string, { accountId: string; name: string }[]> = {};
    for (const conn of connections) {
      accounts[conn.connectionId] = await this.connections.listAccounts(
        user.userId,
        mode,
        conn.connectionId,
      );
    }
    return {
      connections,
      accounts,
      status: {
        configured: connections.some((c) => c.status === 'active'),
        selectedAccountId: connections[0]?.selectedAccountId ?? null,
      },
    };
  }

  @Post('authorize')
  async authorize(
    @CurrentUser() user: AuthenticatedUser,
    @Query('brokerage') brokerage?: string,
    @Query('reconnect') reconnect?: string,
    @Query('connectionType') connectionType?: 'read' | 'trade' | 'trade-if-available',
    @Query('environment') environment?: TradingMode,
  ): Promise<{ redirectUrl: string }> {
    const mode = environment ?? (await this.tradingModeFor(user.userId));
    return this.connections.authorize(user.userId, mode, {
      brokerage,
      reconnect,
      connectionType: connectionType ?? 'trade',
    });
  }

  @Post('reconnect')
  async reconnect(
    @CurrentUser() user: AuthenticatedUser,
    @Query('connectionId') connectionId: string,
    @Query('environment') environment?: TradingMode,
  ): Promise<{ redirectUrl: string }> {
    const mode = environment ?? (await this.tradingModeFor(user.userId));
    return this.connections.reconnect(user.userId, mode, connectionId);
  }

  @Post('select')
  async select(
    @CurrentUser() user: AuthenticatedUser,
    @Query('connectionId') connectionId: string,
    @Query('accountId') accountId: string,
    @Query('environment') environment?: TradingMode,
  ): Promise<{ accountId: string }> {
    const mode = environment ?? (await this.tradingModeFor(user.userId));
    await this.connections.selectAccount(user.userId, mode, connectionId, accountId);
    return { accountId };
  }

  @Delete()
  @Post('disconnect')
  async disconnect(
    @CurrentUser() user: AuthenticatedUser,
    @Query('connectionId') connectionId: string,
    @Query('environment') environment?: TradingMode,
  ): Promise<void> {
    const mode = environment ?? (await this.tradingModeFor(user.userId));
    await this.connections.deleteConnection(user.userId, mode, connectionId);
  }

  private async tradingModeFor(userId: string): Promise<TradingMode> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { tradingMode: true },
    });
    return (user?.tradingMode ?? 'live') as TradingMode;
  }
}
