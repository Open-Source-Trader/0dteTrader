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
 */
@Controller('me/broker-connections/snaptrade')
export class SnapTradeConnectionController {
  constructor(
    private readonly connections: SnapTradeConnectionService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser): Promise<{
    connections: SnapTradeConnectionRecord[];
    accounts: Record<string, { accountId: string; name: string }[]>;
    status: { configured: boolean; selectedAccountId: string | null };
  }> {
    const mode = await this.tradingModeFor(user.userId);
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
  ): Promise<{ redirectUrl: string }> {
    const mode = await this.tradingModeFor(user.userId);
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
  ): Promise<{ redirectUrl: string }> {
    const mode = await this.tradingModeFor(user.userId);
    return this.connections.reconnect(user.userId, mode, connectionId);
  }

  @Post('select')
  async select(
    @CurrentUser() user: AuthenticatedUser,
    @Query('connectionId') connectionId: string,
    @Query('accountId') accountId: string,
  ): Promise<{ accountId: string }> {
    const mode = await this.tradingModeFor(user.userId);
    await this.connections.selectAccount(user.userId, connectionId, accountId);
    await this.prisma.user.update({
      where: { id: user.userId },
      data:
        mode === 'practice'
          ? { snaptradePracticeAccountId: accountId }
          : { snaptradeAccountId: accountId },
    });
    return { accountId };
  }

  @Delete()
  @Post('disconnect')
  async disconnect(
    @CurrentUser() user: AuthenticatedUser,
    @Query('connectionId') connectionId: string,
  ): Promise<void> {
    const mode = await this.tradingModeFor(user.userId);
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
