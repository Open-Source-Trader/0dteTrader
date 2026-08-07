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
  redis: {
    url: string;
    operationTimeoutMs: number;
  };
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
    l2Enabled: boolean;
    l2CapabilityProven: boolean;
    l2AppKey: string;
    l2AppSecret: string;
    l2MaxDepth: number;
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
  snaptrade: {
    /** Production API base URL. Fixed host — not a secret. */
    prodBaseUrl: string;
    /** Sandbox (practice) API base URL. Fixed host — not a secret. */
    sandboxBaseUrl: string;
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
  chartOrders: {
    /** Server-side watcher that fires chart order lines with no client connected. */
    watcherEnabled: boolean;
    /** Poll cadence per (user, underlying) with at least one working line. */
    tickMs: number;
    /** A quote older than this never fires an order (halt, weekend, dead feed). */
    staleQuoteMs: number;
    /** Max concurrent broker getQuote calls per tick, across every (user,
     *  underlying) group with a working line — a single leased watcher
     *  serves the whole deployment, so an unbounded Promise.all fans out
     *  with total platform usage, not one session. */
    quoteConcurrency: number;
  };
  notifications: {
    /** Master switch for the APNs sender; off means no pushes, ever. */
    apnsEnabled: boolean;
    /** APNs auth key id (the 10-char id of the .p8 key). */
    apnsKeyId: string;
    /** Apple developer team id. */
    apnsTeamId: string;
    /** The .p8 key as inline PEM content; wins over apnsKeyPath. */
    apnsKey: string;
    /** Path to the .p8 key file; used when apnsKey is empty. */
    apnsKeyPath: string;
    /** apns-topic header — the app's bundle id. */
    apnsTopic: string;
    /** https://api.sandbox.push.apple.com or https://api.push.apple.com. */
    apnsHost: string;
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
  redis: {
    url: process.env.REDIS_URL ?? '',
    operationTimeoutMs: int(process.env.REDIS_OPERATION_TIMEOUT_MS, 2_000),
  },
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
    l2Enabled: enabled(process.env.WEBULL_L2_ENABLED, false),
    l2CapabilityProven: enabled(process.env.WEBULL_L2_CAPABILITY_PROVEN, false),
    l2AppKey: process.env.WEBULL_L2_APP_KEY ?? '',
    l2AppSecret: process.env.WEBULL_L2_APP_SECRET ?? '',
    l2MaxDepth: int(process.env.WEBULL_L2_MAX_DEPTH, 50),
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
  snaptrade: {
    prodBaseUrl: process.env.SNAPTRADE_PROD_BASE_URL || 'https://api.snaptrade.com',
    sandboxBaseUrl: process.env.SNAPTRADE_SANDBOX_BASE_URL || 'https://api.sandbox.snaptrade.com',
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
    coreSymbols: (process.env.OPTIONS_ANALYTICS_CORE_SYMBOLS ?? 'SPY,QQQ,IWM,SPX,NDX,RUT')
      .split(',')
      .map((symbol) => symbol.trim().toUpperCase())
      .filter((symbol) => symbol !== ''),
  },
  chartOrders: {
    watcherEnabled: enabled(
      process.env.CHART_ORDER_WATCHER_ENABLED,
      (process.env.NODE_ENV ?? 'development') !== 'test',
    ),
    tickMs: int(process.env.CHART_ORDER_WATCHER_TICK_MS, 1_000),
    staleQuoteMs: int(process.env.CHART_ORDER_STALE_QUOTE_MS, 10_000),
    quoteConcurrency: int(process.env.CHART_ORDER_WATCHER_QUOTE_CONCURRENCY, 20),
  },
  notifications: {
    // Off by default: sending requires a provisioned APNs key, and an
    // unconfigured sender must stay inert (tests never set APNS_ENABLED).
    apnsEnabled: enabled(process.env.APNS_ENABLED, false),
    apnsKeyId: process.env.APNS_KEY_ID || '',
    apnsTeamId: process.env.APNS_TEAM_ID || '',
    // The .p8 key, either inline (PEM content) or as a file path.
    apnsKey: process.env.APNS_KEY || '',
    apnsKeyPath: process.env.APNS_KEY_PATH || '',
    apnsTopic: process.env.APNS_TOPIC || 'com.0dtetrader.app',
    // Sandbox by default; set to https://api.push.apple.com for production.
    apnsHost: process.env.APNS_HOST || 'https://api.sandbox.push.apple.com',
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

  // An enabled APNs sender with a missing credential would fail on the first
  // push, hours after boot — surface the misconfiguration at startup instead.
  if (enabled(process.env.APNS_ENABLED, false)) {
    if (!process.env.APNS_KEY_ID || !process.env.APNS_TEAM_ID) {
      throw new Error('APNS_ENABLED requires APNS_KEY_ID and APNS_TEAM_ID');
    }
    if (!process.env.APNS_KEY && !process.env.APNS_KEY_PATH) {
      throw new Error('APNS_ENABLED requires the .p8 key via APNS_KEY or APNS_KEY_PATH');
    }
  }

  if (enabled(process.env.WEBULL_L2_ENABLED, false)) {
    if (!enabled(process.env.WEBULL_L2_CAPABILITY_PROVEN, false)) {
      throw new Error(
        'WEBULL_L2_ENABLED requires WEBULL_L2_CAPABILITY_PROVEN=true after a verified entitlement probe',
      );
    }
    for (const name of ['WEBULL_L2_APP_KEY', 'WEBULL_L2_APP_SECRET', 'REDIS_URL']) {
      if (!process.env[name]?.trim()) throw new Error(`WEBULL_L2_ENABLED requires ${name}`);
    }
    const depth = Number(process.env.WEBULL_L2_MAX_DEPTH ?? '50');
    if (!Number.isInteger(depth) || depth < 1 || depth > 50) {
      throw new Error('WEBULL_L2_MAX_DEPTH must be an integer from 1 to 50');
    }
    try {
      const redisUrl = new URL(process.env.REDIS_URL!);
      if (redisUrl.protocol !== 'redis:' && redisUrl.protocol !== 'rediss:') throw new Error();
    } catch {
      throw new Error('REDIS_URL must be a valid redis:// or rediss:// URL for Level 2');
    }
  }

  return config;
}
