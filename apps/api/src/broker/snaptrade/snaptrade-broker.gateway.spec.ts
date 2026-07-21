import { CredentialsService } from '../../credentials/credentials.service';
import { PrismaService } from '../../prisma/prisma.service';
import { OrderEventsService } from '../order-events.service';
import { MarketDataProvider } from '../broker-gateway.interface';
import { SnapTradeClient } from './snaptrade-client';
import { SnapTradeBrokerGateway } from './snaptrade-broker.gateway';

describe('SnapTradeBrokerGateway', () => {
  it('uses the selected brokerConnection account when loading positions', async () => {
    const client = {
      getAllAccountPositions: jest.fn(async () => ({ results: [] })),
    } as unknown as jest.Mocked<SnapTradeClient>;
    const credentials = {
      getSnapTradeIdentity: jest.fn(async () => ({
        provider: 'snaptrade',
        snaptradeUserId: 'snap-user',
        snaptradeUserSecret: 'snap-secret',
      })),
    } as unknown as jest.Mocked<CredentialsService>;
    const prisma = {
      user: {
        findUnique: jest.fn(async () => ({ tradingProvider: 'snaptrade', tradingMode: 'live' })),
      },
      brokerConnection: {
        findUnique: jest.fn(async () => ({
          selectedAccountId: 'acct-1',
          accountIds: ['acct-1'],
        })),
      },
    } as unknown as PrismaService;
    const events = { emit: jest.fn() } as unknown as jest.Mocked<OrderEventsService>;
    const marketData = {
      getQuote: jest.fn(),
      getCandles: jest.fn(),
      getOptionsChain: jest.fn(),
    } as unknown as jest.Mocked<MarketDataProvider>;

    const gateway = new SnapTradeBrokerGateway(client, credentials, prisma, events, marketData);

    await gateway.getPositions('u1');

    expect(client.getAllAccountPositions).toHaveBeenCalledWith(
      'live',
      'u1',
      'snap-secret',
      'acct-1',
    );
  });
});
