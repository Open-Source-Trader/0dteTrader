import { Injectable } from '@nestjs/common';
import { TradingMode } from '@0dtetrader/shared-types';
import { brokerErrors } from '../../common/broker-error';
import { CredentialsService } from '../../credentials/credentials.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketDataProvider } from '../broker-gateway.interface';

/**
 * Market-data adapter for SnapTrade users.
 *
 * SnapTrade does not source market data directly, so we route to the user's
 * configured legacy market-data provider. Alpaca wins when configured; Webull
 * is the fallback.
 */
@Injectable()
export class SnapTradeMarketDataProvider implements MarketDataProvider {
  constructor(
    private readonly credentials: CredentialsService,
    private readonly prisma: PrismaService,
    private readonly alpaca: MarketDataProvider,
    private readonly webull: MarketDataProvider,
  ) {}

  async getQuote(userId: string, symbol: string) {
    return this.providerFor(userId).then((provider) => provider.getQuote(userId, symbol));
  }

  async getCandles(
    userId: string,
    symbol: string,
    req: Parameters<MarketDataProvider['getCandles']>[2],
  ) {
    return this.providerFor(userId).then((provider) => provider.getCandles(userId, symbol, req));
  }

  async getOptionsChain(userId: string, symbol: string, expiration?: string) {
    return this.providerFor(userId).then((provider) =>
      provider.getOptionsChain(userId, symbol, expiration),
    );
  }

  private async providerFor(userId: string): Promise<MarketDataProvider> {
    const mode = await this.tradingModeFor(userId);
    if (await this.credentials.getDecrypted(userId, 'alpaca', mode)) {
      return this.alpaca;
    }
    if (await this.credentials.getDecrypted(userId, 'webull', mode)) {
      return this.webull;
    }
    throw brokerErrors.authFailed(
      'No Alpaca or Webull credentials on file — save broker credentials in Profile first',
    );
  }

  private async tradingModeFor(userId: string): Promise<TradingMode> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { tradingMode: true },
    });
    return user?.tradingMode === 'practice' ? 'practice' : 'live';
  }
}
