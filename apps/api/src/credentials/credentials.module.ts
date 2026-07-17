import { Module } from '@nestjs/common';
import { CredentialsController } from './credentials.controller';
import { CredentialsService } from './credentials.service';
import { CryptoService } from './crypto.service';

@Module({
  controllers: [CredentialsController],
  providers: [CredentialsService, CryptoService],
  exports: [CredentialsService, CryptoService],
})
export class CredentialsModule {}
