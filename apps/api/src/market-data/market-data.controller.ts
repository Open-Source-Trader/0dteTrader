import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Candle, FuturesContract, OptionsChain, Quote } from '@0dtetrader/shared-types';
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
  FuturesQueryDto,
  OptionsChainQueryDto,
  QuoteQueryDto,
} from './dto/market-query.dto';

@Controller('market')
export class MarketDataController {
  constructor(
    @Inject(BROKER_GATEWAY) private readonly broker: BrokerGateway,
  ) {}

  @Get('quote')
  getQuote(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: QuoteQueryDto,
  ): Promise<Quote> {
    return this.broker.getQuote(user.userId, query.symbol);
  }

  @Get('candles')
  getCandles(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CandlesQueryDto,
  ): Promise<Candle[]> {
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

  @Get('futures')
  getFutures(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: FuturesQueryDto,
  ): Promise<FuturesContract[]> {
    return this.broker.getFuturesContracts(user.userId, query.root);
  }
}
