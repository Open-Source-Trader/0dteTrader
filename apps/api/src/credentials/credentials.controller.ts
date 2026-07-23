import { Body, Controller, Delete, HttpCode, Put, Query } from '@nestjs/common';
import {
  BrokerCredentialsInput,
  BrokerCredentialsSaved,
  WebullCredentialsSaved,
} from '@0dtetrader/shared-types';
import { AuthenticatedUser, CurrentUser } from '../common/current-user.decorator';
import { CredentialsService } from './credentials.service';
import { BrokerCredentialsQueryDto } from './dto/broker-credentials-query.dto';
import { EnvironmentQueryDto } from './dto/environment-query.dto';
import { WebullCredentialsDto } from './dto/webull-credentials.dto';

/**
 * Per-user broker credentials (docs/ARCHITECTURE.md §7).
 *
 * Two route families coexist this phase:
 *  - `me/webull-credentials` — legacy, provider pinned to Webull. The
 *    mobile apps (Phase 3) keep calling it until they move to the generic
 *    endpoint.
 *  - `me/broker-credentials` — generic, provider taken from the body
 *    (PUT) or query (DELETE). Accepts both Webull and Alpaca inputs via
 *    the discriminated `BrokerCredentialsInput` union.
 */
@Controller('me/webull-credentials')
export class CredentialsController {
  constructor(private readonly credentials: CredentialsService) {}

  @Put()
  async save(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: WebullCredentialsDto,
  ): Promise<WebullCredentialsSaved> {
    const environment = (dto.environment ?? 'live') as 'live' | 'practice';
    // Legacy endpoint is Webull-only; the mobile DTO omits `provider`.
    await this.credentials.save(user.userId, { provider: 'webull', ...dto }, environment);
    return { webullConfigured: true, environment };
  }

  @Delete()
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: EnvironmentQueryDto,
  ): Promise<void> {
    await this.credentials.remove(user.userId, 'webull', query.environment ?? 'live');
  }
}

/**
 * Generic, provider-aware credentials endpoint. Replaces the Webull-pinned
 * routes once the mobile apps adopt it (Phase 3); both are kept in parallel
 * this phase so the legacy clients keep working.
 */
@Controller('me/broker-credentials')
export class BrokerCredentialsController {
  constructor(private readonly credentials: CredentialsService) {}

  @Put()
  async save(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BrokerCredentialsInput,
  ): Promise<BrokerCredentialsSaved> {
    const environment = (dto.environment ?? 'live') as 'live' | 'practice';
    const provider = dto.provider ?? 'webull';
    await this.credentials.save(user.userId, dto, environment);
    return { provider, configured: true, environment };
  }

  @Delete()
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BrokerCredentialsQueryDto,
  ): Promise<void> {
    const provider = query.provider ?? 'webull';
    await this.credentials.remove(user.userId, provider, query.environment ?? 'live');
  }
}
