import { Body, Controller, Delete, HttpCode, Put, Query } from '@nestjs/common';
import { WebullCredentialsSaved } from '@0dtetrader/shared-types';
import { AuthenticatedUser, CurrentUser } from '../common/current-user.decorator';
import { CredentialsService } from './credentials.service';
import { EnvironmentQueryDto } from './dto/environment-query.dto';
import { WebullCredentialsDto } from './dto/webull-credentials.dto';

@Controller('me/webull-credentials')
export class CredentialsController {
  constructor(private readonly credentials: CredentialsService) {}

  @Put()
  async save(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: WebullCredentialsDto,
  ): Promise<WebullCredentialsSaved> {
    const environment = dto.environment ?? 'live';
    await this.credentials.save(user.userId, dto, environment);
    return { webullConfigured: true, environment };
  }

  @Delete()
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: EnvironmentQueryDto,
  ): Promise<void> {
    await this.credentials.remove(user.userId, query.environment ?? 'live');
  }
}
