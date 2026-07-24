import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { WebullAccount } from '@0dtetrader/shared-types';
import { AuthenticatedUser, CurrentUser } from '../common/current-user.decorator';
import { EnvironmentQueryDto } from '../credentials/dto/environment-query.dto';
import { WebullBrokerGateway } from './webull/webull-broker.gateway';

class SelectWebullAccountDto {
  @IsString()
  @MinLength(1)
  accountId!: string;

  @IsOptional()
  @IsIn(['live', 'practice'])
  environment?: 'live' | 'practice';
}

@Controller('me/webull-accounts')
export class WebullAccountController {
  constructor(private readonly webull: WebullBrokerGateway) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: EnvironmentQueryDto,
  ): Promise<WebullAccount[]> {
    return this.webull.listAccounts(user.userId, query.environment ?? 'live');
  }

  @Patch()
  async select(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SelectWebullAccountDto,
  ): Promise<void> {
    await this.webull.selectAccount(user.userId, dto.environment ?? 'live', dto.accountId);
  }
}
