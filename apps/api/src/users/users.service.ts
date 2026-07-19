import { Injectable } from '@nestjs/common';
import { Me, TradingMode } from '@0dtetrader/shared-types';
import { errors } from '../common/api-exception';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(userId: string): Promise<Me> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw errors.unauthorized('USER_NOT_FOUND', 'User no longer exists');
    }
    const [live, practice] = await Promise.all([
      this.prisma.webullCredential.findUnique({
        where: { userId_environment: { userId, environment: 'live' } },
      }),
      this.prisma.webullCredential.findUnique({
        where: { userId_environment: { userId, environment: 'practice' } },
      }),
    ]);
    return {
      id: user.id,
      email: user.email,
      tradingDisabled: user.tradingDisabled,
      tradingMode: user.tradingMode as TradingMode,
      webullConfigured: live !== null,
      webullPracticeConfigured: practice !== null,
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
}
