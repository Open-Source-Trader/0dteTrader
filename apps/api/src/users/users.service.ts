import { Injectable } from '@nestjs/common';
import { Me } from '@0dtetrader/shared-types';
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
    const credential = await this.prisma.webullCredential.findUnique({
      where: { userId },
    });
    return {
      id: user.id,
      email: user.email,
      tradingDisabled: user.tradingDisabled,
      webullConfigured: credential !== null,
    };
  }
}
