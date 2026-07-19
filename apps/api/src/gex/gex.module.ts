import { Module } from '@nestjs/common';
import { GexController } from './gex.controller';
import { GexService } from './gex.service';

@Module({
  controllers: [GexController],
  providers: [GexService],
})
export class GexModule {}
