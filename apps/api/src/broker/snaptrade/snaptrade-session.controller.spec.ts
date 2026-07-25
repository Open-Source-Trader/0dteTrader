import { PrismaService } from '../../prisma/prisma.service';
import { SnapTradeConnectionService } from './snaptrade-connection.service';
import { SnapTradeConnectionController } from './snaptrade-session.controller';

describe('SnapTradeConnectionController', () => {
  it('selects the account through the connection service without updating user fields', async () => {
    const connections = {
      selectAccount: jest.fn(async () => undefined),
    } as unknown as jest.Mocked<SnapTradeConnectionService>;
    const prisma = {
      user: {
        update: jest.fn(),
        findUnique: jest.fn(async () => ({ tradingMode: 'live' })),
      },
    } as unknown as PrismaService;
    const controller = new SnapTradeConnectionController(connections, prisma);

    await expect(controller.select({ userId: 'u1' } as never, 'conn-1', 'acct-1')).resolves.toEqual(
      { accountId: 'acct-1' },
    );

    expect(connections.selectAccount).toHaveBeenCalledWith('u1', 'live', 'conn-1', 'acct-1');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('uses the explicit environment query param over the user global tradingMode', async () => {
    const connections = {
      selectAccount: jest.fn(async () => undefined),
    } as unknown as jest.Mocked<SnapTradeConnectionService>;
    const prisma = {
      user: {
        update: jest.fn(),
        findUnique: jest.fn(async () => ({ tradingMode: 'live' })),
      },
    } as unknown as PrismaService;
    const controller = new SnapTradeConnectionController(connections, prisma);

    await controller.select({ userId: 'u1' } as never, 'conn-1', 'acct-1', 'practice');

    expect(connections.selectAccount).toHaveBeenCalledWith('u1', 'practice', 'conn-1', 'acct-1');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});
