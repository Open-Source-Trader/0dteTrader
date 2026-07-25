import { ConfigService } from '@nestjs/config';
import { SnapTradeClient } from './snaptrade-client';

describe('SnapTradeClient', () => {
  it('fails fast when the caller has no SnapTrade credentials', async () => {
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'snaptrade.prodBaseUrl') return 'https://api.snaptrade.com';
        return undefined;
      }),
    } as unknown as ConfigService;
    const client = new SnapTradeClient(config);

    await expect(client.listConnections('live', '', '')).rejects.toThrow(
      'No SnapTrade credentials',
    );
  });
});
