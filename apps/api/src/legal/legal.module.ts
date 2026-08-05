import { Module } from '@nestjs/common';
import { PublicLegalController, UserLegalController } from './legal.controller';
import { LegalService } from './legal.service';

@Module({
  controllers: [PublicLegalController, UserLegalController],
  providers: [LegalService],
  exports: [LegalService],
})
export class LegalModule {}
