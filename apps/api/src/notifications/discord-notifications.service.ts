import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  DiscordNotificationSettings,
  DiscordNotificationSettingsUpdate,
} from '@0dtetrader/shared-types';
import { Subscription } from 'rxjs';
import { OrderEventsService, OrderUpdateEvent } from '../broker/order-events.service';
import { errors, isUniqueViolation } from '../common/api-exception';
import { CryptoService } from '../credentials/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersService } from '../trading/orders.service';
import { OPTION_MULTIPLIER, parseOccSymbol } from '../broker/contract-resolution';

const REQUEST_TIMEOUT_MS = 3_000;

interface DiscordPostOutcome {
  delivered: boolean;
  attempts: number;
  responseStatus?: number;
}

@Injectable()
export class DiscordNotificationsService implements OnModuleDestroy {
  private readonly logger = new Logger(DiscordNotificationsService.name);
  private readonly subscription: Subscription;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly orders: OrdersService,
    events: OrderEventsService,
  ) {
    this.subscription = events.events$.subscribe((event) => {
      if (event.order.status !== 'filled') return;
      void this.deliverFill(event).catch((error) =>
        this.logger.warn(`Discord fill notification failed: ${(error as Error).message}`),
      );
    });
  }

  onModuleDestroy(): void {
    this.subscription.unsubscribe();
  }

  async get(userId: string): Promise<DiscordNotificationSettings> {
    const row = await this.prisma.discordNotificationSettings.findUnique({ where: { userId } });
    return {
      configured: row?.encWebhookUrl != null,
      maskedWebhookUrl: row?.encWebhookUrl
        ? this.mask(this.crypto.decrypt(row.encWebhookUrl))
        : null,
      enabled: row?.enabled ?? false,
      includePnl: row?.includePnl ?? false,
    };
  }

  async update(
    userId: string,
    input: DiscordNotificationSettingsUpdate,
  ): Promise<DiscordNotificationSettings> {
    const existing = await this.prisma.discordNotificationSettings.findUnique({
      where: { userId },
    });
    const webhookUrl = input.webhookUrl?.trim();
    if (webhookUrl) this.assertWebhookUrl(webhookUrl);
    if (input.enabled && !webhookUrl && !existing?.encWebhookUrl) {
      throw errors.validation('Save a Discord webhook URL before enabling notifications');
    }
    await this.prisma.discordNotificationSettings.upsert({
      where: { userId },
      create: {
        userId,
        encWebhookUrl: webhookUrl ? this.crypto.encrypt(webhookUrl) : null,
        enabled: input.enabled,
        includePnl: input.includePnl,
      },
      update: {
        ...(webhookUrl ? { encWebhookUrl: this.crypto.encrypt(webhookUrl) } : {}),
        enabled: input.enabled,
        includePnl: input.includePnl,
      },
    });
    return this.get(userId);
  }

  async test(userId: string): Promise<void> {
    const row = await this.prisma.discordNotificationSettings.findUnique({ where: { userId } });
    if (!row?.encWebhookUrl) throw errors.validation('Save a Discord webhook URL first');
    const response = await this.post(this.crypto.decrypt(row.encWebhookUrl), {
      username: '0dteTrader',
      embeds: [
        {
          title: 'Discord notifications connected',
          description: 'Filled buy and sell orders will be posted here.',
          color: 0x21c55d,
        },
      ],
    });
    if (!response.delivered) {
      throw errors.unavailable('DISCORD_WEBHOOK_FAILED', 'Discord rejected the test notification');
    }
  }

  private async deliverFill(event: OrderUpdateEvent): Promise<void> {
    const { userId, order } = event;
    const settings = await this.prisma.discordNotificationSettings.findUnique({
      where: { userId },
    });
    if (!settings?.enabled || !settings.encWebhookUrl) return;
    const internalOrderId = await this.persistedOrderIdentity(event);
    let claim;
    try {
      claim = await this.prisma.discordDelivery.create({
        data: {
          userId,
          key: internalOrderId
            ? ['order', 'internal', internalOrderId, 'filled'].join(':')
            : [
                'order',
                event.provider ?? 'legacy',
                event.environment ?? 'unknown',
                event.accountId ?? 'default',
                event.brokerOrderId ?? event.clientOrderId ?? order.orderId,
                'filled',
              ].join(':'),
          status: 'pending',
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) return;
      throw error;
    }
    let pnl: number | null = null;
    if (settings.includePnl && internalOrderId) {
      pnl = await this.orders
        .realizedPnlForInternalOrder(userId, internalOrderId)
        .catch(() => null);
    }
    const fillQuantity = order.filledQuantity ?? order.quantity;
    const contract = parseOccSymbol(order.contractSymbol);
    const contractLabel = contract
      ? `${contract.underlying} ${contract.expiration} ${contract.strike} ${contract.optionType.toUpperCase()}`
      : order.contractSymbol;
    const fields: Array<{ name: string; value: string; inline: boolean }> = [
      { name: 'Contract', value: contractLabel, inline: true },
      { name: 'Quantity', value: String(order.filledQuantity ?? order.quantity), inline: true },
      { name: 'Price', value: order.filledPrice?.toFixed(2) ?? '—', inline: true },
    ];
    if (order.filledPrice !== undefined) {
      fields.push({
        name: 'Total Premium',
        value: `$${(order.filledPrice * fillQuantity * OPTION_MULTIPLIER).toFixed(2)}`,
        inline: true,
      });
    }
    if (settings.includePnl && pnl !== null) {
      fields.push({
        name: 'Realized P/L',
        value: `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`,
        inline: true,
      });
    }
    const outcome = await this.post(this.crypto.decrypt(settings.encWebhookUrl), {
      username: '0dteTrader',
      embeds: [
        {
          title: `${order.side.toUpperCase()} filled`,
          description: `${order.contractSymbol} order filled`,
          color: order.side === 'buy' ? 0x21c55d : 0xef4444,
          fields,
          timestamp: order.filledAt ?? order.timestamp,
        },
      ],
    });
    await this.prisma.discordDelivery.update({
      where: { id: claim.id },
      data: outcome.delivered
        ? {
            status: 'delivered',
            attempts: outcome.attempts,
            deliveredAt: new Date(),
            lastError: null,
          }
        : {
            status: 'failed',
            attempts: outcome.attempts,
            lastError: 'Discord webhook request failed',
          },
    });
    if (!outcome.delivered) {
      this.logger.warn(
        JSON.stringify({
          event: 'discord_fill_delivery_failed',
          deliveryId: claim.id,
          userId,
          orderId: internalOrderId ?? order.orderId,
          attempts: outcome.attempts,
          ...(outcome.responseStatus !== undefined && {
            responseStatus: outcome.responseStatus,
          }),
        }),
      );
    }
  }

  /** Resolve all aliases through the scoped persisted order row. A placement
   * event may carry a client id while a later webhook carries only the broker
   * id; using the row UUID gives both reports one delivery key. */
  private async persistedOrderIdentity(event: OrderUpdateEvent): Promise<string | null> {
    const identifiers = [
      event.clientOrderId?.trim(),
      event.brokerOrderId?.trim(),
      event.order.orderId.trim(),
    ].filter((identifier): identifier is string => Boolean(identifier));
    if (identifiers.length === 0) return null;
    const rows = await this.prisma.tradeOrder.findMany({
      where: {
        userId: event.userId,
        ...(event.provider ? { provider: event.provider } : {}),
        ...(event.environment ? { environment: event.environment } : {}),
        ...(event.accountId ? { accountId: event.accountId } : {}),
        OR: [
          ...identifiers.map((brokerOrderId) => ({ brokerOrderId })),
          ...identifiers.map((clientOrderId) => ({ clientOrderId })),
        ],
      },
    });
    if (rows.length === 1) return rows[0].id;
    const exact = rows.filter(
      (row) =>
        (!event.brokerOrderId || row.brokerOrderId === event.brokerOrderId) &&
        (!event.clientOrderId || row.clientOrderId === event.clientOrderId),
    );
    return exact.length === 1 ? exact[0].id : null;
  }

  private async post(url: string, payload: unknown): Promise<DiscordPostOutcome> {
    let responseStatus: number | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        responseStatus = response.status;
        if (response.ok) return { delivered: true, attempts: attempt + 1, responseStatus };
        if (response.status !== 429 && response.status < 500) {
          return { delivered: false, attempts: attempt + 1, responseStatus };
        }
      } catch {
        // One bounded retry covers timeouts and transient transport failures.
      }
      if (attempt === 0) {
        // Yield outside the broker/order pipeline (delivery is a detached
        // subscriber) and avoid immediately hammering the same rate-limit or
        // transient outage.
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    return { delivered: false, attempts: 2, responseStatus };
  }

  private assertWebhookUrl(value: string): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw errors.validation('Enter a valid Discord webhook URL');
    }
    const allowedHosts = new Set(['discord.com', 'discordapp.com']);
    const authority = value.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1] ?? '';
    const authorityHost = authority.slice(authority.lastIndexOf('@') + 1);
    const path = /^\/api\/webhooks\/(\d+)\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
    if (
      url.protocol !== 'https:' ||
      !allowedHosts.has(url.hostname) ||
      !path ||
      url.username !== '' ||
      url.password !== '' ||
      authorityHost.includes(':') ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      throw errors.validation(
        'Webhook must exactly match https://discord.com/api/webhooks/{id}/{token}',
      );
    }
  }

  private mask(value: string): string {
    const url = new URL(value);
    const parts = url.pathname.split('/');
    const token = parts[parts.length - 1] ?? '';
    return `${url.origin}/api/webhooks/••••/••••${token.slice(-4)}`;
  }
}
