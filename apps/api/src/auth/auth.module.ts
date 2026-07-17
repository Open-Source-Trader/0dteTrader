import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';

/**
 * JwtModule is registered without a default secret/expiry on purpose: access
 * and refresh tokens use different secrets and TTLs, passed explicitly at
 * every sign/verify call (JWT_ACCESS_* / JWT_REFRESH_*).
 */
@Module({
  imports: [JwtModule.register({ global: true })],
  controllers: [AuthController],
  providers: [AuthService, PasswordService],
  exports: [AuthService, PasswordService],
})
export class AuthModule {}
