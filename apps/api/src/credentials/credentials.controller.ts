import { Body, Controller, Delete, HttpCode, Put } from '@nestjs/common';
import { WebullCredentialsSaved } from '@0dtetrader/shared-types';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../common/current-user.decorator';
import { CredentialsService } from './credentials.service';
import { WebullCredentialsDto } from './dto/webull-credentials.dto';

@Controller('me/webull-credentials')
export class CredentialsController {
  constructor(private readonly credentials: CredentialsService) {}

  @Put()
  async save(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: WebullCredentialsDto,
  ): Promise<WebullCredentialsSaved> {
    await this.credentials.save(user.userId, dto);
    return { webullConfigured: true };
  }

  @Delete()
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.credentials.remove(user.userId);
  }
}
