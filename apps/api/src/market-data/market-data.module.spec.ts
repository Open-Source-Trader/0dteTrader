import { ConfigService } from '@nestjs/config';
import { AppKeyRateLimiter, RedisRateLease } from './order-book-rate-limiter';
import { WebullClientOrderBookTransport, WebullOrderBookProvider } from './order-book.provider';
import { OrderBookService } from './order-book.service';
import { MarketDataModule } from './market-data.module';

describe('MarketDataModule Level 2 wiring', () => {
  const providers = Reflect.getMetadata('providers', MarketDataModule) as unknown[];

  it.each([
    RedisRateLease,
    WebullClientOrderBookTransport,
    WebullOrderBookProvider,
    AppKeyRateLimiter,
    OrderBookService,
  ])('registers %p as an application provider', (provider) => {
    const registered = providers.some((entry) => {
      if (entry === provider) return true;
      return (
        typeof entry === 'object' && entry !== null && Reflect.get(entry, 'provide') === provider
      );
    });
    expect(registered).toBe(true);
  });

  it('keeps the production provider fail-closed until both switches are proven', () => {
    const registration = providers.find(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        Reflect.get(entry, 'provide') === WebullOrderBookProvider,
    ) as {
      useFactory: (
        transport: WebullClientOrderBookTransport,
        config: ConfigService,
      ) => WebullOrderBookProvider;
    };
    const config = {
      get: jest.fn(
        (key: string) =>
          ({
            'webull.l2Enabled': false,
            'webull.l2CapabilityProven': false,
            'webull.l2MaxDepth': 50,
            'webull.l2AppKey': 'redacted-key',
          })[key],
      ),
    } as unknown as ConfigService;
    const provider = registration.useFactory(
      { requestDepth: jest.fn() } as unknown as WebullClientOrderBookTransport,
      config,
    );

    expect(provider.preflight('SPY')?.status.reason).toBe('provider_unconfigured');
  });
});
