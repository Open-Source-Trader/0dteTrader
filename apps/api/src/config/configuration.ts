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
  brokerGateway: 'mock' | 'webull';
  webull: {
    apiBaseUrl: string;
    /** Falls back to apiBaseUrl when unset. */
    marketDataBaseUrl: string;
  };
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export default (): AppConfig => ({
  port: int(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgresql://odtetrader:odtetrader@localhost:5432/odtetrader',
  jwt: {
    accessSecret:
      process.env.JWT_ACCESS_SECRET ??
      'dev-only-access-secret-change-me-0123456789',
    refreshSecret:
      process.env.JWT_REFRESH_SECRET ??
      'dev-only-refresh-secret-change-me-0123456789',
    accessTtl: int(process.env.JWT_ACCESS_TTL, 900),
    refreshTtl: int(process.env.JWT_REFRESH_TTL, 1209600),
  },
  credEncryptionKey: process.env.CRED_ENCRYPTION_KEY,
  brokerGateway: process.env.BROKER_GATEWAY === 'webull' ? 'webull' : 'mock',
  webull: {
    apiBaseUrl:
      process.env.WEBULL_API_BASE_URL || 'https://api.sandbox.webull.com',
    marketDataBaseUrl:
      process.env.WEBULL_MARKET_DATA_BASE_URL ||
      process.env.WEBULL_API_BASE_URL ||
      'https://api.sandbox.webull.com',
  },
});

/**
 * Fail-fast validation of security-critical environment at boot.
 * Called by ConfigModule.forRoot({ validate }).
 */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const nodeEnv = (config['NODE_ENV'] as string) ?? 'development';

  if (nodeEnv === 'production') {
    for (const name of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
      const value = process.env[name];
      if (!value || value.length < 32 || value.startsWith('change-me')) {
        throw new Error(
          `${name} must be set to a strong secret (>= 32 chars) in production`,
        );
      }
    }
    const key = process.env.CRED_ENCRYPTION_KEY;
    if (!key || Buffer.from(key, 'base64').length !== 32) {
      throw new Error(
        'CRED_ENCRYPTION_KEY must be a base64-encoded 32-byte key in production',
      );
    }
  }

  if (process.env.CRED_ENCRYPTION_KEY) {
    const decoded = Buffer.from(process.env.CRED_ENCRYPTION_KEY, 'base64');
    if (decoded.length !== 32) {
      throw new Error(
        'CRED_ENCRYPTION_KEY is set but is not a base64-encoded 32-byte key. ' +
          'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
      );
    }
  }

  return config;
}
