import { ConfigService } from '@nestjs/config';
import { SnapTradeClient } from './snaptrade-client';

describe('SnapTradeClient', () => {
  it('fails fast when server SnapTrade credentials are missing', async () => {
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'snaptrade.clientId') return '';
        if (key === 'snaptrade.consumerKey') return '';
        if (key === 'snaptrade.prodBaseUrl') return 'https://api.snaptrade.com';
        return undefined;
      }),
    } as unknown as ConfigService;
    const client = new SnapTradeClient(config);

    await expect(client.registerUser('live', 'u1')).rejects.toThrow(
      'SnapTrade is not configured on this server',
    );
  });
});
