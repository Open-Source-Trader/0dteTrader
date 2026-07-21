import { Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { OrderEventsService } from '../order-events.service';

const MAX_REPLAY_DRIFT_MS = 300_000;

/**
 * SnapTrade webhook receiver.
 *
 * - Verifies the `Signature` header: HMAC-SHA256(canonical body, consumerKey), base64.
 * - Rejects replays where `eventTimestamp` is older than 5 minutes.
 * - Always returns 2xx (SnapTrade retries with 30-min exponential backoff, 3 tries).
 *
 * Register this URL in the SnapTrade Dashboard.
 */
@Controller('webhooks/snaptrade')
export class SnapTradeWebhookController {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly events: OrderEventsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const signature = req.headers['signature'] as string | undefined;
    const timestampHeader = req.headers['eventtimestamp'] as string | undefined;
    const consumerKey =
      this.config.get<string>('snaptrade.webhookConsumerKey') ??
      this.config.get<string>('snaptrade.consumerKey') ??
      '';

    if (!signature || !timestampHeader || !consumerKey) {
      res.sendStatus(HttpStatus.BAD_REQUEST);
      return;
    }

    const body = JSON.stringify(req.body ?? {});

    // Replay guard.
    const eventTimestamp = Date.parse(timestampHeader);
    if (
      Number.isNaN(eventTimestamp) ||
      Math.abs(Date.now() - eventTimestamp) > MAX_REPLAY_DRIFT_MS
    ) {
      res.sendStatus(HttpStatus.BAD_REQUEST);
      return;
    }

    // Signature verification: HMAC-SHA256(body, consumerKey) base64.
    const expected = createHmac('sha256', consumerKey).update(body).digest('base64');
    const actual = Buffer.from(signature);
    if (
      actual.length !== Buffer.from(expected).length ||
      !timingSafeEqual(actual, Buffer.from(expected))
    ) {
      res.sendStatus(HttpStatus.UNAUTHORIZED);
      return;
    }

    const event = (req.body ?? {}) as Record<string, unknown>;
    const eventType = typeof event['event'] === 'string' ? (event['event'] as string) : '';
    const userId = typeof event['userId'] === 'string' ? (event['userId'] as string) : '';

    if (!userId) {
      res.sendStatus(HttpStatus.BAD_REQUEST);
      return;
    }

    try {
      await this.dispatch(eventType, userId, event);
    } catch {
      // Log but still 2xx so SnapTrade stops retrying.
    }

    res.sendStatus(HttpStatus.OK);
  }

  private async dispatch(
    eventType: string,
    userId: string,
    event: Record<string, unknown>,
  ): Promise<void> {
    switch (eventType) {
      case 'CONNECTION_ADDED':
        await this.handleConnectionAdded(userId, event);
        break;
      case 'CONNECTION_BROKEN':
        await this.handleConnectionBroken(userId, event);
        break;
      case 'NEW_ACCOUNT_AVAILABLE':
        await this.handleNewAccountAvailable(userId, event);
        break;
      case 'TRADE_UPDATE':
      case 'TRADE_DETECTION':
        await this.handleTradeUpdate(userId, event);
        break;
      default:
        break;
    }
  }

  private async handleConnectionAdded(
    userId: string,
    event: Record<string, unknown>,
  ): Promise<void> {
    const connectionId =
      typeof event['connectionId'] === 'string' ? (event['connectionId'] as string) : '';
    if (!connectionId) return;
    const accounts = Array.isArray(event['accounts'])
      ? (event['accounts'] as Array<{ id?: string }>)
      : [];
    const accountIds = accounts
      .map((a) => a.id)
      .filter((id): id is string => typeof id === 'string');

    await this.prisma.brokerConnection.upsert({
      where: { userId_provider: { userId, provider: 'snaptrade' } },
      create: {
        userId,
        provider: 'snaptrade',
        connectionId,
        accountIds,
        selectedAccountId: accountIds[0] ?? null,
        status: 'active',
      },
      update: {
        connectionId,
        accountIds,
        status: 'active',
      },
    });
  }

  private async handleConnectionBroken(
    userId: string,
    event: Record<string, unknown>,
  ): Promise<void> {
    const connectionId =
      typeof event['connectionId'] === 'string' ? (event['connectionId'] as string) : '';
    if (!connectionId) return;
    await this.prisma.brokerConnection.updateMany({
      where: { userId, provider: 'snaptrade', connectionId },
      data: { status: 'broken' },
    });
  }

  private async handleNewAccountAvailable(
    userId: string,
    event: Record<string, unknown>,
  ): Promise<void> {
    const connectionId =
      typeof event['connectionId'] === 'string' ? (event['connectionId'] as string) : '';
    const accountId = typeof event['accountId'] === 'string' ? (event['accountId'] as string) : '';
    if (!connectionId || !accountId) return;
    await this.prisma.brokerConnection.updateMany({
      where: { userId, provider: 'snaptrade', connectionId },
      data: { accountIds: { push: accountId } },
    });
  }

  private async handleTradeUpdate(userId: string, event: Record<string, unknown>): Promise<void> {
    const order = (event['order'] ?? event['trade']) as Record<string, unknown> | undefined;
    if (!order) return;
    const mapped = this.mapOrderResult(order);
    this.events.emit(userId, mapped);
  }

  private mapOrderResult(order: Record<string, unknown>): {
    orderId: string;
    status: 'submitted' | 'filled' | 'partially_filled' | 'cancelled' | 'rejected';
    contractSymbol: string;
    side: 'buy' | 'sell';
    quantity: number;
    orderType: 'market' | 'mid';
    limitPrice?: number;
    filledPrice?: number;
    filledQuantity?: number;
    timestamp: string;
  } {
    const status = this.mapStatus(order['status'] as string | undefined);
    const brokerageOrderId =
      typeof order['brokerage_order_id'] === 'string' ? order['brokerage_order_id'] : '';
    return {
      orderId: brokerageOrderId,
      status,
      contractSymbol: this.extractSymbol(order),
      side: this.mapSide(order['action'] as string | undefined),
      quantity: Number(order['total_quantity'] ?? 0),
      orderType: this.mapOrderType(order['order_type'] as string | undefined),
      limitPrice: order['limit_price'] ? Number(order['limit_price']) : undefined,
      filledPrice: order['execution_price'] ? Number(order['execution_price']) : undefined,
      filledQuantity: order['filled_quantity'] ? Number(order['filled_quantity']) : undefined,
      timestamp: (order['time_placed'] as string) ?? new Date().toISOString(),
    };
  }

  private mapStatus(
    status: string | undefined,
  ): 'submitted' | 'filled' | 'partially_filled' | 'cancelled' | 'rejected' {
    const s = (status ?? '').toUpperCase();
    if (['EXECUTED', 'FILLED'].includes(s)) return 'filled';
    if (['PARTIAL', 'PARTIALLY_FILLED', 'PARTIAL_CANCELED'].includes(s)) return 'partially_filled';
    if (['CANCELED', 'CANCELLED', 'EXPIRED', 'CANCEL_PENDING'].includes(s)) return 'cancelled';
    if (['FAILED', 'REJECTED'].includes(s)) return 'rejected';
    return 'submitted';
  }

  private mapSide(action: string | undefined): 'buy' | 'sell' {
    const a = (action ?? '').toUpperCase();
    if (a.startsWith('SELL')) return 'sell';
    return 'buy';
  }

  private mapOrderType(type: string | undefined): 'market' | 'mid' {
    const t = (type ?? '').toUpperCase();
    return t === 'MARKET' ? 'market' : 'mid';
  }

  private extractSymbol(order: Record<string, unknown>): string {
    const optionSymbol = order['option_symbol'] as Record<string, unknown> | undefined;
    if (optionSymbol?.ticker && typeof optionSymbol.ticker === 'string') {
      return optionSymbol.ticker;
    }
    const universalSymbol = order['universal_symbol'] as Record<string, unknown> | undefined;
    if (universalSymbol?.symbol && typeof universalSymbol.symbol === 'string') {
      return universalSymbol.symbol;
    }
    return '';
  }
}
