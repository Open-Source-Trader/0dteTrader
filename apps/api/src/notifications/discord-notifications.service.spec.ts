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
  let history: jest.Mock;

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
    history = jest.fn(async () => ({ entries: [], totalRealizedPnl: 0 }));
    service = new DiscordNotificationsService(
      prisma as never,
      crypto,
      { history } as unknown as OrdersService,
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

  it('does not block event ingestion while Discord is unresponsive', async () => {
    await service.update(userId, {
      webhookUrl: 'https://discord.com/api/webhooks/123/secret',
      enabled: true,
      includePnl: false,
    });
    let releaseRequest!: (response: { ok: boolean; status: number }) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRequest = resolve;
        }),
    );

    await events.ingest(userId, {
      orderId: 'non-blocking-fill',
      status: 'filled',
      contractSymbol: 'SPY260805C00500000',
      side: 'buy',
      quantity: 1,
      orderType: 'market',
      filledPrice: 1.25,
      timestamp: new Date().toISOString(),
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    releaseRequest({ ok: true, status: 204 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(prisma.discordDeliveries[0].status).toBe('delivered');
  });

  it('omits realized P/L for an opening fill even when the toggle is enabled', async () => {
    await service.update(userId, {
      webhookUrl: 'https://discord.com/api/webhooks/123/secret',
      enabled: true,
      includePnl: true,
    });
    events.emit(userId, {
      orderId: 'opening-fill',
      status: 'filled',
      contractSymbol: 'SPY260805C00500000',
      side: 'buy',
      quantity: 1,
      orderType: 'market',
      filledPrice: 1.25,
      timestamp: new Date().toISOString(),
    });
    await new Promise((resolve) => setImmediate(resolve));

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(payload.embeds[0].fields.map((field: { name: string }) => field.name)).not.toContain(
      'Realized P/L',
    );
  });

  it('includes closing P/L when a webhook carries only the broker identity', async () => {
    await service.update(userId, {
      webhookUrl: 'https://discord.com/api/webhooks/123/secret',
      enabled: true,
      includePnl: true,
    });
    history.mockResolvedValue({
      entries: [
        {
          orderId: 'placement-client-id',
          clientOrderId: 'placement-client-id',
          brokerOrderId: 'broker-close-id',
          realizedPnl: 125,
        },
      ],
      totalRealizedPnl: 125,
    });
    events.emit(
      userId,
      {
        orderId: 'broker-close-id',
        status: 'filled',
        contractSymbol: 'SPY260805C00500000',
        side: 'sell',
        quantity: 1,
        orderType: 'market',
        filledPrice: 2.5,
        timestamp: new Date().toISOString(),
      },
      'live',
      { provider: 'snaptrade', accountId: 'account-a', brokerOrderId: 'broker-close-id' },
    );
    await new Promise((resolve) => setImmediate(resolve));

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(payload.embeds[0].fields).toContainEqual({
      name: 'Realized P/L',
      value: '+$125.00',
      inline: true,
    });
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
