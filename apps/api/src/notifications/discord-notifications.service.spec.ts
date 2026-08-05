import { ConfigService } from '@nestjs/config';
import { OrderEventsService } from '../broker/order-events.service';
import { CryptoService } from '../credentials/crypto.service';
import { InMemoryPrismaService } from '../../test/in-memory-prisma.service';
import { OrdersService } from '../trading/orders.service';
import { DiscordNotificationsService } from './discord-notifications.service';

const originalFetch = global.fetch;

describe('DiscordNotificationsService', () => {
  let prisma: InMemoryPrismaService;
  let events: OrderEventsService;
  let service: DiscordNotificationsService;
  let userId: string;
  let fetchMock: jest.Mock;

  beforeEach(async () => {
    prisma = new InMemoryPrismaService();
    events = new OrderEventsService();
    const crypto = new CryptoService({
      get: (key: string) => (key === 'nodeEnv' ? 'test' : undefined),
    } as unknown as ConfigService);
    crypto.onModuleInit();
    userId = (
      await prisma.user.create({ data: { email: 'discord@example.com', passwordHash: 'x' } })
    ).id;
    service = new DiscordNotificationsService(
      prisma as never,
      crypto,
      {
        history: jest.fn(async () => ({ entries: [], totalRealizedPnl: 0 })),
      } as unknown as OrdersService,
      events,
    );
    fetchMock = jest.fn(async () => ({ ok: true, status: 204 }));
    global.fetch = fetchMock;
  });

  afterEach(() => {
    service.onModuleDestroy();
    global.fetch = originalFetch;
  });

  it('stores the webhook encrypted and only returns a mask', async () => {
    const settings = await service.update(userId, {
      webhookUrl: 'https://discord.com/api/webhooks/123/super-secret-token',
      enabled: true,
      includePnl: false,
    });

    expect(settings).toMatchObject({ configured: true, enabled: true });
    expect(settings.maskedWebhookUrl).not.toContain('super-secret-token');
    expect(Buffer.from(prisma.discordSettingsRows[0].encWebhookUrl).toString()).not.toContain(
      'super-secret-token',
    );
  });

  it('posts only filled buys/sells and claims duplicate reports exactly once', async () => {
    await service.update(userId, {
      webhookUrl: 'https://discord.com/api/webhooks/123/secret',
      enabled: true,
      includePnl: false,
    });
    const order = {
      orderId: 'order-1',
      status: 'filled' as const,
      contractSymbol: 'SPY260805C00500000',
      side: 'buy' as const,
      quantity: 1,
      orderType: 'market' as const,
      filledPrice: 1.25,
      timestamp: new Date().toISOString(),
    };

    events.emit(userId, { ...order, status: 'submitted' });
    events.emit(userId, order);
    events.emit(userId, order);
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prisma.discordDeliveries).toHaveLength(1);
    expect(prisma.discordDeliveries[0].status).toBe('delivered');
  });

  it('uses one bounded retry for a transient Discord response', async () => {
    await service.update(userId, {
      webhookUrl: 'https://discord.com/api/webhooks/123/secret',
      enabled: true,
      includePnl: false,
    });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204 });

    await service.test(userId);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not collapse matching external ids from separate broker accounts', async () => {
    await service.update(userId, {
      webhookUrl: 'https://discord.com/api/webhooks/123/secret',
      enabled: true,
      includePnl: false,
    });
    const order = {
      orderId: 'shared-id',
      status: 'filled' as const,
      contractSymbol: 'SPY260805C00500000',
      side: 'sell' as const,
      quantity: 1,
      orderType: 'market' as const,
      timestamp: new Date().toISOString(),
    };

    events.emit(userId, order, 'live', {
      provider: 'snaptrade',
      accountId: 'account-a',
      brokerOrderId: order.orderId,
    });
    events.emit(userId, order, 'live', {
      provider: 'snaptrade',
      accountId: 'account-b',
      brokerOrderId: order.orderId,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(prisma.discordDeliveries).toHaveLength(2);
  });
});
