import { Controller, Get, Query } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { GexService } from './gex.service';
import type { GexLevels } from './gex.types';

class GexQueryDto {
  @IsString()
  symbol!: string;

  @IsOptional()
  @IsString()
  expiration?: string;
}

@Controller('market')
export class GexController {
  constructor(private readonly gex: GexService) {}

  /** Dealer GEX/DEX levels + premium heat map for one underlying. */
  @Get('gex')
  getGexLevels(@Query() query: GexQueryDto): Promise<GexLevels> {
    return this.gex.getLevels(query.symbol, query.expiration);
  }
}
