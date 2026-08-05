import { Injectable, Logger } from '@nestjs/common';
import { TradingMode } from '@0dtetrader/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { OrderEventsService } from '../order-events.service';
import { compactOcc, mapOrderStatus } from './snaptrade-mappers';

/** Applies one already-authenticated SnapTrade inbox payload. */
@Injectable()
export class SnapTradeWebhookProcessorService {
  private readonly logger = new Logger(SnapTradeWebhookProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: OrderEventsService,
  ) {}

  async process(
    eventType: string,
    userId: string,
    environment: TradingMode,
    event: Record<string, unknown>,
    webhookId: string,
  ): Promise<void> {
    switch (eventType) {
      case 'CONNECTION_ADDED':
        await this.handleConnectionAdded(userId, environment, event);
        break;
      case 'CONNECTION_BROKEN':
        await this.handleConnectionBroken(userId, environment, event);
        break;
      case 'NEW_ACCOUNT_AVAILABLE':
        await this.handleNewAccountAvailable(userId, environment, event);
        break;
      case 'TRADE_UPDATE':
      case 'TRADE_DETECTION':
        await this.handleTradeUpdate(userId, environment, event, webhookId);
        break;
      default:
        break;
    }
  }

  private async handleConnectionAdded(
    userId: string,
    environment: TradingMode,
    event: Record<string, unknown>,
  ): Promise<void> {
    const connectionId = this.string(event['brokerageAuthorizationId']);
    if (connectionId === '') return;
    const accounts = Array.isArray(event['accounts'])
      ? (event['accounts'] as Array<{ id?: string }>)
      : [];
    const accountIds = accounts
      .map((account) => account.id)
      .filter((id): id is string => typeof id === 'string');
    await this.prisma.brokerConnection.upsert({
      where: { userId_provider_environment: { userId, provider: 'snaptrade', environment } },
      create: {
        userId,
        provider: 'snaptrade',
        environment,
        connectionId,
        accountIds,
        selectedAccountId: accountIds[0] ?? null,
        status: 'active',
      },
      update: { connectionId, accountIds, status: 'active' },
    });
  }

  private async handleConnectionBroken(
    userId: string,
    environment: TradingMode,
    event: Record<string, unknown>,
  ): Promise<void> {
    const connectionId = this.string(event['brokerageAuthorizationId']);
    if (connectionId === '') return;
    await this.prisma.brokerConnection.updateMany({
      where: { userId, provider: 'snaptrade', environment, connectionId },
      data: { status: 'broken' },
    });
  }

  private async handleNewAccountAvailable(
    userId: string,
    environment: TradingMode,
    event: Record<string, unknown>,
  ): Promise<void> {
    const connectionId = this.string(event['brokerageAuthorizationId']);
    const accountId = this.string(event['accountId']);
    if (connectionId === '' || accountId === '') return;
    await this.prisma.brokerConnection.updateMany({
      where: {
        userId,
        provider: 'snaptrade',
        environment,
        connectionId,
        NOT: { accountIds: { has: accountId } },
      },
      data: { accountIds: { push: accountId } },
    });
  }

  private async handleTradeUpdate(
    userId: string,
    environment: TradingMode,
    event: Record<string, unknown>,
    webhookId: string,
  ): Promise<void> {
    const details = event['details'] as Record<string, unknown> | undefined;
    const orders = Array.isArray(details?.['orders'])
      ? (details['orders'] as Array<Record<string, unknown>>)
      : [];
    for (const order of orders) {
      const mapped = this.mapOrderResult(order);
      const brokerOrderId = this.string(order['brokerage_order_id']);
      const clientOrderId =
        this.string(order['client_order_id']) || this.string(order['clientOrderId']);
      if (brokerOrderId === '' && clientOrderId === '') continue;
      if (mapped.orderId === '') mapped.orderId = clientOrderId;
      const accountId =
        this.string(order['account_id']) ||
        this.string(event['accountId']) ||
        this.string(details?.['accountId']) ||
        'default';
      try {
        await this.events.ingest(userId, mapped, environment, {
          provider: 'snaptrade',
          accountId,
          brokerOrderId: brokerOrderId || undefined,
          clientOrderId: clientOrderId || undefined,
          sourceEventId: webhookId,
        });
      } catch (error) {
        this.logger.error(
          JSON.stringify({
            event: 'snaptrade_webhook_order_ingest_failed',
            userId,
            environment,
            webhookId,
            orderId: mapped.orderId,
            status: mapped.status,
            stage: 'order_ingest',
            message: (error as Error).message,
          }),
        );
        throw error;
      }
    }
  }

  private mapOrderResult(order: Record<string, unknown>) {
    const brokerageOrderId = this.string(order['brokerage_order_id']);
    return {
      orderId: brokerageOrderId,
      status: mapOrderStatus(order['status'] as string | undefined),
      contractSymbol: this.extractSymbol(order),
      side: this.mapSide(order['action'] as string | undefined),
      quantity: Number(order['total_quantity'] ?? 0),
      orderType: this.mapOrderType(order['order_type'] as string | undefined),
      limitPrice: order['limit_price'] ? Number(order['limit_price']) : undefined,
      filledPrice: order['execution_price'] ? Number(order['execution_price']) : undefined,
      filledQuantity: order['filled_quantity'] ? Number(order['filled_quantity']) : undefined,
      filledAt: this.string(order['time_executed']) || undefined,
      timestamp: this.string(order['time_placed']) || new Date().toISOString(),
    };
  }

  private mapSide(action: string | undefined): 'buy' | 'sell' {
    return (action ?? '').toUpperCase().startsWith('SELL') ? 'sell' : 'buy';
  }

  private mapOrderType(type: string | undefined): 'market' | 'mid' {
    return (type ?? '').toUpperCase() === 'MARKET' ? 'market' : 'mid';
  }

  private extractSymbol(order: Record<string, unknown>): string {
    const legs = Array.isArray(order['legs'])
      ? (order['legs'] as Array<Record<string, unknown>>)
      : [];
    const instrument = legs[0]?.['instrument'] as Record<string, unknown> | undefined;
    if (typeof instrument?.['symbol'] === 'string') return compactOcc(instrument['symbol']);
    const optionSymbol = order['option_symbol'] as Record<string, unknown> | undefined;
    if (typeof optionSymbol?.['ticker'] === 'string') return compactOcc(optionSymbol['ticker']);
    const universalSymbol = order['universal_symbol'] as Record<string, unknown> | undefined;
    return this.string(universalSymbol?.['symbol']);
  }

  private string(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }
}
