import { Body, Controller, Get, Patch } from '@nestjs/common';
import { Me } from '@0dtetrader/shared-types';
import { AuthenticatedUser, CurrentUser } from '../common/current-user.decorator';
import { UpdateMeDto } from './dto/update-me.dto';
import { UsersService } from './users.service';

@Controller('me')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  getMe(@CurrentUser() user: AuthenticatedUser): Promise<Me> {
    return this.users.getMe(user.userId);
  }

  @Patch()
  async updateMe(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateMeDto): Promise<Me> {
    let me = await this.users.getMe(user.userId);
    if (dto.tradingMode) {
      me = await this.users.setTradingMode(user.userId, dto.tradingMode);
    }
    if (dto.tradingProvider) {
      me = await this.users.setTradingProvider(user.userId, dto.tradingProvider);
    }
    return me;
  }
}
