import { Controller, Get, Logger, Query } from '@nestjs/common';
import { Candle, OptionsChain, Quote } from '@0dtetrader/shared-types';
import { AuthenticatedUser, CurrentUser } from '../common/current-user.decorator';
import { timed } from '../common/timing';
import { CandlesQueryDto, OptionsChainQueryDto, QuoteQueryDto } from './dto/market-query.dto';
import { CryptoDataService } from './crypto-data.service';
import { IndexDataService } from './index-data.service';
import { OptionsAnalyticsService } from '../options-analytics/options-analytics.service';
import { TradierMarketDataService } from './tradier-market-data.service';

@Controller('market')
export class MarketDataController {
  private readonly logger = new Logger(MarketDataController.name);

  constructor(
    private readonly tradierMarketData: TradierMarketDataService,
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
    // Market quotes are sourced from Tradier regardless of the user's
    // trading broker. Tradier returns a fresh NBBO in a single HTTP call;
    // Alpaca requires stockSnapshots and Webull requires optionSnapshot
    // probes, both of which are more expensive for the same data.
    return this.tradierMarketData.getQuote(query.symbol);
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
      // Market candles are sourced from Tradier regardless of the user's
      // trading broker. Tradier serves native bars for 1m/5m/15m (time-sales)
      // and 1d/1w (history); 30m/1h/4h are aggregated from 1m in a single
      // upstream call.
      return this.tradierMarketData.getCandles(query.symbol, {
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
