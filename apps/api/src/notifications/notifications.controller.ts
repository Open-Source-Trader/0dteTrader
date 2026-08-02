import { Body, Controller, Delete, HttpCode, Param, Post } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '../common/current-user.decorator';
import { DeviceRegistrationDto } from './dto/device-registration.dto';
import { DevicesService } from './devices.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly devices: DevicesService) {}

  /** Idempotent upsert; re-registering a token moves it to the caller. */
  @Post('devices')
  @HttpCode(204)
  async register(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DeviceRegistrationDto,
  ): Promise<void> {
    await this.devices.register(user.userId, dto.token.toLowerCase(), dto.platform);
  }

  /** Scoped to the caller; an absent or foreign token is a 204 no-op. */
  @Delete('devices/:token')
  @HttpCode(204)
  async unregister(
    @CurrentUser() user: AuthenticatedUser,
    @Param('token') token: string,
  ): Promise<void> {
    await this.devices.unregister(user.userId, token.toLowerCase());
  }
}
