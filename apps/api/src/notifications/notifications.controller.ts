import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { DiscordNotificationSettings } from '@0dtetrader/shared-types';
import { AuthenticatedUser, CurrentUser } from '../common/current-user.decorator';
import { DeviceRegistrationDto } from './dto/device-registration.dto';
import { DevicesService } from './devices.service';
import { DiscordSettingsDto } from './dto/discord-settings.dto';
import { DiscordNotificationsService } from './discord-notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly devices: DevicesService,
    private readonly discord: DiscordNotificationsService,
  ) {}

  @Get('discord')
  discordSettings(@CurrentUser() user: AuthenticatedUser): Promise<DiscordNotificationSettings> {
    return this.discord.get(user.userId);
  }

  @Put('discord')
  updateDiscord(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DiscordSettingsDto,
  ): Promise<DiscordNotificationSettings> {
    return this.discord.update(user.userId, dto);
  }

  @Post('discord/test')
  @HttpCode(204)
  testDiscord(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.discord.test(user.userId);
  }

  /** Idempotent upsert; re-registering a token moves it to the caller. */
  @Post('devices')
  @HttpCode(204)
  async register(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DeviceRegistrationDto,
  ): Promise<void> {
    await this.devices.register(user.userId, dto.token.toLowerCase(), dto.platform);
  }

  /** Possession-authorized: presenting the token removes its registration
   *  whoever owns it (see DevicesService.unregister); absent is a 204 no-op. */
  @Delete('devices/:token')
  @HttpCode(204)
  async unregister(
    @CurrentUser() _user: AuthenticatedUser,
    @Param('token') token: string,
  ): Promise<void> {
    await this.devices.unregister(token.toLowerCase());
  }
}
