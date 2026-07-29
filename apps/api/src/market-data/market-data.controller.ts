import { Controller, Get, Inject, Logger, Query } from '@nestjs/common';
import { Candle, OptionsChain, Quote } from '@0dtetrader/shared-types';
import { BROKER_GATEWAY, BrokerGateway } from '../broker/broker-gateway.interface';
import { AuthenticatedUser, CurrentUser } from '../common/current-user.decorator';
import { timed } from '../common/timing';
import { CandlesQueryDto, OptionsChainQueryDto, QuoteQueryDto } from './dto/market-query.dto';
import { CryptoDataService } from './crypto-data.service';
import { IndexDataService } from './index-data.service';
import { OptionsAnalyticsService } from '../options-analytics/options-analytics.service';

@Controller('market')
export class MarketDataController {
  private readonly logger = new Logger(MarketDataController.name);

  constructor(
    @Inject(BROKER_GATEWAY) private readonly broker: BrokerGateway,
    private readonly analytics: OptionsAnalyticsService,
    private readonly crypto: CryptoDataService,
    private readonly index: IndexDataService,
  ) {}

  @Get('quote')
  getQuote(@CurrentUser() user: AuthenticatedUser, @Query() query: QuoteQueryDto): Promise<Quote> {
    if (this.crypto.isCryptoSymbol(query.symbol)) {
      return this.crypto.getQuote(query.symbol);
    }
    if (this.index.isIndexSymbol(query.symbol)) {
      return this.index.getQuote(query.symbol, user.userId);
    }
    return this.broker.getQuote(user.userId, query.symbol);
  }

  @Get('candles')
  getCandles(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CandlesQueryDto,
  ): Promise<Candle[]> {
    return timed(this.logger, `market.candles.${query.symbol}`, () => {
      if (this.crypto.isCryptoSymbol(query.symbol)) {
        return this.crypto.getCandles(query.symbol, query.interval, query.from, query.to);
      }
      if (this.index.isIndexSymbol(query.symbol)) {
        return this.index.getCandles(
          query.symbol,
          query.interval,
          query.from,
          query.to,
          user.userId,
        );
      }
      return this.broker.getCandles(user.userId, query.symbol, {
        interval: query.interval,
        from: query.from,
        to: query.to,
      });
    });
  }

  @Get('options-chain')
  getOptionsChain(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: OptionsChainQueryDto,
  ): Promise<OptionsChain> {
    // Options chain + Greeks are sourced from Tradier (the designated options
    // market-data provider), independent of the user's trading broker. The
    // user's stored Tradier key is preferred; the shared token is the fallback.
    return timed(this.logger, `market.options-chain.${query.symbol}`, () =>
      this.analytics.getOptionsChain(query.symbol, query.expiration, user.userId),
    );
  }
}
