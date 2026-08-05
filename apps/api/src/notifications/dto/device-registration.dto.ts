import { IsIn, Matches } from 'class-validator';

/** Mirrors shared-types `DeviceRegistration` / docs/openapi.yaml. */
export class DeviceRegistrationDto {
  /** Hex APNs device token — 32 bytes today, but Apple documents the length
   *  as variable, so accept a bounded hex string rather than exactly 64. */
  @Matches(/^[0-9a-fA-F]{64,160}$/)
  token!: string;

  @IsIn(['ios'])
  platform!: 'ios';
}
