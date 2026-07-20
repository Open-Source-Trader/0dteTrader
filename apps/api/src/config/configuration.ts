export interface AppConfig {
  port: number;
  nodeEnv: string;
  databaseUrl: string;
  jwt: {
    accessSecret: string;
    refreshSecret: string;
    /** seconds */
    accessTtl: number;
    /** seconds */
    refreshTtl: number;
  };
  credEncryptionKey?: string;
  webull: {
    /** Practice (sandbox) overrides; default to the sandbox hosts. */
    apiBaseUrl: string;
    /** Falls back to the api.* → data-api.* derivation of apiBaseUrl. */
    marketDataBaseUrl: string;
    /** Live (production) overrides; default to the prod hosts. */
    liveApiBaseUrl: string;
    /** Falls back to liveApiBaseUrl (api. → data-api.) when unset. */
    liveMarketDataBaseUrl: string;
    /** Built-in practice app credentials — fallback when a user has not
     *  stored their own practice credentials. */
    practiceAppKey: string;
    practiceAppSecret: string;
    practiceAccountId: string;
    practiceApplicationId: string;
  };
  tradier: {
    /** Personal Tradier API token (brokerage or paper account). */
    token: string;
    /** https://api.tradier.com or https://sandbox.tradier.com. */
    baseUrl: string;
  };
  alpaca: {
    /** Live trading host (https://api.alpaca.markets). */
    tradingBaseUrl: string;
    /** Paper trading host (https://paper-api.alpaca.markets). */
    paperTradingBaseUrl: string;
    /** Live market-data host (https://data.alpaca.markets). */
    dataBaseUrl: string;
    /** Paper market-data host (https://paper-data.alpaca.markets). */
    paperDataBaseUrl: string;
  };
  optionsAnalytics: {
    riskFreeRate: number;
    cacheTtlMs: number;
    cacheHardTtlMs: number;
    cacheMaxEntries: number;
    expirationCacheTtlMs: number;
    captureEnabled: boolean;
    coreSymbols: string[];
  };
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function float(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function enabled(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
}

export default (): AppConfig => ({
  port: int(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgresql://odtetrader:odtetrader@localhost:5432/odtetrader',
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET ?? 'dev-only-access-secret-change-me-0123456789',
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? 'dev-only-refresh-secret-change-me-0123456789',
    accessTtl: int(process.env.JWT_ACCESS_TTL, 900),
    refreshTtl: int(process.env.JWT_REFRESH_TTL, 1209600),
  },
  credEncryptionKey: process.env.CRED_ENCRYPTION_KEY,
  webull: {
    apiBaseUrl: process.env.WEBULL_API_BASE_URL || 'https://api.sandbox.webull.com',
    marketDataBaseUrl:
      process.env.WEBULL_MARKET_DATA_BASE_URL ||
      dataHostOf(process.env.WEBULL_API_BASE_URL || 'https://api.sandbox.webull.com'),
    liveApiBaseUrl: process.env.WEBULL_LIVE_API_BASE_URL || 'https://api.webull.com',
    liveMarketDataBaseUrl:
      process.env.WEBULL_LIVE_MARKET_DATA_BASE_URL ||
      dataHostOf(process.env.WEBULL_LIVE_API_BASE_URL),
    practiceAppKey: process.env.WEBULL_PRACTICE_APP_KEY ?? '',
    practiceAppSecret: process.env.WEBULL_PRACTICE_APP_SECRET ?? '',
    practiceAccountId: process.env.WEBULL_PRACTICE_ACCOUNT_ID ?? '',
    practiceApplicationId: process.env.WEBULL_PRACTICE_APPLICATION_ID ?? '',
  },
  tradier: {
    token: process.env.TRADIER_API_TOKEN ?? '',
    baseUrl: process.env.TRADIER_BASE_URL || 'https://api.tradier.com',
  },
  alpaca: {
    tradingBaseUrl: process.env.ALPACA_TRADING_BASE_URL || 'https://api.alpaca.markets',
    paperTradingBaseUrl:
      process.env.ALPACA_PAPER_TRADING_BASE_URL || 'https://paper-api.alpaca.markets',
    dataBaseUrl: process.env.ALPACA_DATA_BASE_URL || 'https://data.alpaca.markets',
    paperDataBaseUrl: process.env.ALPACA_PAPER_DATA_BASE_URL || 'https://paper-data.alpaca.markets',
  },
  optionsAnalytics: {
    riskFreeRate: float(process.env.OPTIONS_ANALYTICS_RISK_FREE_RATE, 0.043),
    cacheTtlMs: int(process.env.OPTIONS_ANALYTICS_CACHE_TTL_MS, 15_000),
    cacheHardTtlMs: int(process.env.OPTIONS_ANALYTICS_CACHE_HARD_TTL_MS, 120_000),
    cacheMaxEntries: int(process.env.OPTIONS_ANALYTICS_CACHE_MAX_ENTRIES, 128),
    expirationCacheTtlMs: int(process.env.OPTIONS_ANALYTICS_EXPIRATION_CACHE_TTL_MS, 15 * 60_000),
    captureEnabled: enabled(
      process.env.OPTIONS_ANALYTICS_CAPTURE_ENABLED,
      (process.env.NODE_ENV ?? 'development') !== 'test',
    ),
    coreSymbols: (process.env.OPTIONS_ANALYTICS_CORE_SYMBOLS ?? 'SPY,QQQ,IWM,SPX')
      .split(',')
      .map((symbol) => symbol.trim().toUpperCase())
      .filter((symbol) => symbol !== ''),
  },
});

/** Derives the market-data host (api.* → data-api.*) from an API host. */
function dataHostOf(apiBaseUrl: string | undefined): string {
  const api = apiBaseUrl || 'https://api.webull.com';
  return api.replace(/^https:\/\/api\./, 'https://data-api.');
}

/**
 * Fail-fast validation of security-critical environment at boot.
 * Called by ConfigModule.forRoot({ validate }).
 */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const nodeEnv = (config['NODE_ENV'] as string) ?? 'development';

  if (nodeEnv === 'production') {
    for (const name of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
      const value = process.env[name];
      if (
        !value ||
        value.length < 32 ||
        value.includes('change-me') ||
        value.startsWith('dev-only')
      ) {
        throw new Error(`${name} must be set to a strong secret (>= 32 chars) in production`);
      }
    }
    const key = process.env.CRED_ENCRYPTION_KEY;
    if (!key || Buffer.from(key, 'base64').length !== 32) {
      throw new Error('CRED_ENCRYPTION_KEY must be a base64-encoded 32-byte key in production');
    }
  }

  if (process.env.CRED_ENCRYPTION_KEY) {
    const decoded = Buffer.from(process.env.CRED_ENCRYPTION_KEY, 'base64');
    if (decoded.length !== 32) {
      throw new Error(
        'CRED_ENCRYPTION_KEY is set but is not a base64-encoded 32-byte key. ' +
          "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
      );
    }
  }

  return config;
}
