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
  let realizedPnlForInternalOrder: jest.Mock;

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
    realizedPnlForInternalOrder = jest.fn(async () => null);
    service = new DiscordNotificationsService(
      prisma as never,
      crypto,
      { realizedPnlForInternalOrder } as unknown as OrdersService,
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

  it.each([
    'https://discord.com/api/webhooks/',
    'https://discord.com/api/webhooks/not-an-id/token',
    'https://discord.com/api/webhooks/123',
    'https://discord.com/api/webhooks/123/token/extra',
    'https://discord.com.evil.example/api/webhooks/123/token',
    'https://user:pass@discord.com/api/webhooks/123/token',
    'https://discord.com:8443/api/webhooks/123/token',
    'https://discord.com/api/webhooks/123/token#fragment',
  ])('rejects a malformed or unsafe webhook URL: %s', async (webhookUrl) => {
    await expect(
      service.update(userId, { webhookUrl, enabled: false, includePnl: false }),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(prisma.discordSettingsRows).toHaveLength(0);
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

  it('logs a sanitized fill-delivery failure and records the actual attempt count', async () => {
    await service.update(userId, {
      webhookUrl: 'https://discord.com/api/webhooks/123/super-secret-token',
      enabled: true,
      includePnl: false,
    });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    const logger = (service as unknown as { logger: { warn: (message: string) => void } }).logger;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    events.emit(userId, {
      orderId: 'revoked-webhook-fill',
      status: 'filled',
      contractSymbol: 'SPY260805C00500000',
      side: 'sell',
      quantity: 1,
      orderType: 'market',
      timestamp: new Date().toISOString(),
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prisma.discordDeliveries[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls[0][0];
    expect(logged).toContain('discord_fill_delivery_failed');
    expect(logged).toContain('revoked-webhook-fill');
    expect(logged).not.toContain('super-secret-token');
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
    const persisted = await prisma.tradeOrder.create({
      data: {
        userId,
        provider: 'snaptrade',
        environment: 'live',
        accountId: 'account-a',
        clientOrderId: 'placement-client-id',
        brokerOrderId: 'broker-close-id',
        contractSymbol: 'SPY260805C00500000',
        side: 'sell',
        quantity: 1,
        orderType: 'market',
        status: 'filled',
        placedAt: new Date(),
      },
    });
    realizedPnlForInternalOrder.mockResolvedValue(125);
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
    expect(realizedPnlForInternalOrder).toHaveBeenCalledWith(userId, persisted.id);
  });

  it('deduplicates a client-and-broker fill followed by a broker-only alias', async () => {
    await service.update(userId, {
      webhookUrl: 'https://discord.com/api/webhooks/123/secret',
      enabled: true,
      includePnl: false,
    });
    await prisma.tradeOrder.create({
      data: {
        userId,
        provider: 'webull',
        environment: 'live',
        accountId: 'account-a',
        clientOrderId: 'client-fill-id',
        brokerOrderId: 'broker-fill-id',
        contractSymbol: 'SPY260805C00500000',
        side: 'sell',
        quantity: 1,
        orderType: 'market',
        status: 'filled',
        placedAt: new Date(),
      },
    });
    const fill = {
      orderId: 'client-fill-id',
      status: 'filled' as const,
      contractSymbol: 'SPY260805C00500000',
      side: 'sell' as const,
      quantity: 1,
      orderType: 'market' as const,
      timestamp: new Date().toISOString(),
    };

    events.emit(userId, fill, 'live', {
      provider: 'webull',
      accountId: 'account-a',
      clientOrderId: 'client-fill-id',
      brokerOrderId: 'broker-fill-id',
    });
    events.emit(userId, { ...fill, orderId: 'broker-fill-id' }, 'live', {
      provider: 'webull',
      accountId: 'account-a',
      brokerOrderId: 'broker-fill-id',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prisma.discordDeliveries).toHaveLength(1);
    expect(prisma.discordDeliveries[0].key).toContain('internal');
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
