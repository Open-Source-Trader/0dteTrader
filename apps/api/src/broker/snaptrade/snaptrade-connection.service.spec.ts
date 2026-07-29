import { InMemoryPrismaService } from '../../../test/in-memory-prisma.service';
import { CredentialsService } from '../../credentials/credentials.service';
import { SnapTradeClient } from './snaptrade-client';
import { SnapTradeConnectionService } from './snaptrade-connection.service';

describe('SnapTradeConnectionService', () => {
  let prisma: InMemoryPrismaService;
  let credentials: jest.Mocked<CredentialsService>;
  let client: jest.Mocked<SnapTradeClient>;
  let service: SnapTradeConnectionService;

  beforeEach(() => {
    prisma = new InMemoryPrismaService();
    credentials = {
      getDecrypted: jest.fn(async () => ({
        provider: 'snaptrade' as const,
        clientId: 'c1',
        consumerKey: 'k1',
      })),
    } as unknown as jest.Mocked<CredentialsService>;
    client = {
      listConnections: jest.fn(async () => []),
      deleteConnection: jest.fn(async () => undefined),
      authorize: jest.fn(async () => ({ redirectUrl: 'https://portal' })),
    } as unknown as jest.Mocked<SnapTradeClient>;
    service = new SnapTradeConnectionService(client, credentials, prisma as never);
  });

  it('selectAccount keeps live and practice connections independent for the same user', async () => {
    await service.selectAccount('u1', 'live', 'conn-live', 'acct-live');
    await service.selectAccount('u1', 'practice', 'conn-practice', 'acct-practice');

    const live = prisma.brokerConnections.find(
      (c) => c.userId === 'u1' && c.environment === 'live',
    );
    const practice = prisma.brokerConnections.find(
      (c) => c.userId === 'u1' && c.environment === 'practice',
    );

    expect(live?.selectedAccountId).toBe('acct-live');
    expect(live?.connectionId).toBe('conn-live');
    expect(practice?.selectedAccountId).toBe('acct-practice');
    expect(practice?.connectionId).toBe('conn-practice');
    expect(prisma.brokerConnections).toHaveLength(2);
  });

  it('deleteConnection only removes the row for the requested environment', async () => {
    await service.selectAccount('u1', 'live', 'conn-live', 'acct-live');
    await service.selectAccount('u1', 'practice', 'conn-practice', 'acct-practice');

    await service.deleteConnection('u1', 'live', 'conn-live');

    expect(prisma.brokerConnections).toHaveLength(1);
    expect(prisma.brokerConnections[0]?.environment).toBe('practice');
  });

  it('listConnections only merges local rows from the requested environment', async () => {
    await service.selectAccount('u1', 'live', 'conn-1', 'acct-live');
    await service.selectAccount('u1', 'practice', 'conn-1', 'acct-practice');
    client.listConnections.mockResolvedValueOnce([
      { id: 'conn-1', name: 'Test', type: 'trade', status: 'APPROVED' } as never,
    ]);

    const result = await service.listConnections('u1', 'live');

    expect(result).toHaveLength(1);
    expect(result[0].selectedAccountId).toBe('acct-live');
  });
});
