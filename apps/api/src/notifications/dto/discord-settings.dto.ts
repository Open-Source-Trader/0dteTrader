import { IsBoolean, IsOptional, IsUrl } from 'class-validator';

export class DiscordSettingsDto {
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  webhookUrl?: string;

  @IsBoolean()
  enabled!: boolean;

  @IsBoolean()
  includePnl!: boolean;
}
