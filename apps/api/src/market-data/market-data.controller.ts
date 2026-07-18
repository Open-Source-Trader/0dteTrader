import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Candle, OptionsChain, Quote } from '@0dtetrader/shared-types';
import {
  BROKER_GATEWAY,
  BrokerGateway,
} from '../broker/broker-gateway.interface';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../common/current-user.decorator';
import {
  CandlesQueryDto,
  OptionsChainQueryDto,
  QuoteQueryDto,
} from './dto/market-query.dto';
import { CryptoDataService } from './crypto-data.service';

@Controller('market')
export class MarketDataController {
  constructor(
    @Inject(BROKER_GATEWAY) private readonly broker: BrokerGateway,
    private readonly crypto: CryptoDataService,
  ) {}

  @Get('quote')
  getQuote(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: QuoteQueryDto,
  ): Promise<Quote> {
    if (this.crypto.isCryptoSymbol(query.symbol)) {
      return this.crypto.getQuote(query.symbol);
    }
    return this.broker.getQuote(user.userId, query.symbol);
  }

  @Get('candles')
  getCandles(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CandlesQueryDto,
  ): Promise<Candle[]> {
    if (this.crypto.isCryptoSymbol(query.symbol)) {
      return this.crypto.getCandles(query.symbol, query.interval, query.from, query.to);
    }
    return this.broker.getCandles(user.userId, query.symbol, {
      interval: query.interval,
      from: query.from,
      to: query.to,
    });
  }

  @Get('options-chain')
  getOptionsChain(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: OptionsChainQueryDto,
  ): Promise<OptionsChain> {
    return this.broker.getOptionsChain(user.userId, query.symbol, query.expiration);
  }
}
