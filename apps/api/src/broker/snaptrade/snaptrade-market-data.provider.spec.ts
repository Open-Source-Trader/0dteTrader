import { CredentialsService } from '../../credentials/credentials.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketDataProvider } from '../broker-gateway.interface';
import { SnapTradeMarketDataProvider } from './snaptrade-market-data.provider';

function makeProvider(overrides?: { alpaca?: boolean; webull?: boolean }) {
  const alpaca = {
    getQuote: jest.fn(async (_userId: string, symbol: string) => ({ symbol })),
    getCandles: jest.fn(async () => []),
    getOptionsChain: jest.fn(async () => ({
      underlying: 'SPY',
      underlyingPrice: 0,
      expirations: [],
      contracts: [],
    })),
  } as unknown as jest.Mocked<MarketDataProvider>;
  const webull = {
    getQuote: jest.fn(async (_userId: string, symbol: string) => ({ symbol })),
    getCandles: jest.fn(async () => []),
    getOptionsChain: jest.fn(async () => ({
      underlying: 'SPY',
      underlyingPrice: 0,
      expirations: [],
      contracts: [],
    })),
  } as unknown as jest.Mocked<MarketDataProvider>;
  const credentials = {
    getDecrypted: jest.fn(async (_userId: string, provider: string) => {
      if (provider === 'alpaca') return overrides?.alpaca ? { provider: 'alpaca' } : null;
      if (provider === 'webull') return overrides?.webull ? { provider: 'webull' } : null;
      return null;
    }),
  } as unknown as CredentialsService;
  const prisma = {
    user: { findUnique: jest.fn(async () => ({ tradingMode: 'live' })) },
  } as unknown as PrismaService;
  return {
    provider: new SnapTradeMarketDataProvider(credentials, prisma, alpaca, webull),
    alpaca,
    webull,
  };
}

describe('SnapTradeMarketDataProvider', () => {
  it('prefers Alpaca market data when Alpaca is configured and Webull is not', async () => {
    const env = makeProvider({ alpaca: true, webull: false });

    await env.provider.getQuote('u1', 'SPY');
    await env.provider.getCandles('u1', 'SPY', { interval: '1m' });
    await env.provider.getOptionsChain('u1', 'SPY');

    expect(env.alpaca.getQuote).toHaveBeenCalledWith('u1', 'SPY');
    expect(env.alpaca.getCandles).toHaveBeenCalledWith('u1', 'SPY', { interval: '1m' });
    expect(env.alpaca.getOptionsChain).toHaveBeenCalledWith('u1', 'SPY', undefined);
    expect(env.webull.getQuote).not.toHaveBeenCalled();
  });

  it('falls back to Webull when Alpaca is not configured', async () => {
    const env = makeProvider({ alpaca: false, webull: true });

    await env.provider.getQuote('u1', 'SPY');

    expect(env.webull.getQuote).toHaveBeenCalledWith('u1', 'SPY');
    expect(env.alpaca.getQuote).not.toHaveBeenCalled();
  });
});
