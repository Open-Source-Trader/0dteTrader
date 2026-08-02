import { Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { TradingMode } from '@0dtetrader/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { CredentialsService } from '../../credentials/credentials.service';
import { OrderEventsService } from '../order-events.service';

const MAX_REPLAY_DRIFT_MS = 300_000;

/** JSON.stringify with sorted keys and no extra whitespace — matches
 *  SnapTrade's own canonicalization (`json.dumps(payload, separators=(",", ":"), sort_keys=True)`
 *  per docs.snaptrade.com/docs/webhooks) so the HMAC is computed over the
 *  exact bytes SnapTrade signed, regardless of the key order Express/JSON
 *  parsing happens to preserve. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    );
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * SnapTrade webhook receiver (Personal API key mode).
 *
 * - Every webhook payload carries a `clientId` (docs.snaptrade.com/docs/webhooks
 *   — present on every event type). Under the Personal API key model each app
 *   user has their own `clientId`, so this is what identifies which of our
 *   users an event belongs to — **not** the payload's `userId`, which is
 *   SnapTrade's own internal user identifier and is meaningless to us since
 *   we never register or manage SnapTrade users.
 * - Verifies the `Signature` header: HMAC-SHA256(canonical body, that user's
 *   own consumerKey), base64. There is no single server-side consumer key to
 *   verify against — each user's events are signed with their own key, so
 *   the owning user must be resolved (via `clientId`) before the signature
 *   can be checked.
 * - Rejects replays where `eventTimestamp` is older than 5 minutes.
 * - Always returns 2xx (SnapTrade retries with 30-min exponential backoff, 3 tries).
 *
 * Each user registers this same URL in their own SnapTrade Dashboard.
 */
@Controller('webhooks/snaptrade')
export class SnapTradeWebhookController {
  constructor(
    private readonly credentials: CredentialsService,
    private readonly prisma: PrismaService,
    private readonly events: OrderEventsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const signature = req.headers['signature'] as string | undefined;
    const timestampHeader = req.headers['eventtimestamp'] as string | undefined;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const clientId = typeof body['clientId'] === 'string' ? (body['clientId'] as string) : '';

    if (!signature || !timestampHeader || !clientId) {
      res.sendStatus(HttpStatus.BAD_REQUEST);
      return;
    }

    // Replay guard.
    const eventTimestamp = Date.parse(timestampHeader);
    if (
      Number.isNaN(eventTimestamp) ||
      Math.abs(Date.now() - eventTimestamp) > MAX_REPLAY_DRIFT_MS
    ) {
      res.sendStatus(HttpStatus.BAD_REQUEST);
      return;
    }

    // Resolve which app user this clientId belongs to, then verify the
    // signature with THAT user's own consumerKey — there is no shared
    // server-side key under the Personal API key model.
    const owner = await this.credentials.findUserBySnapTradeClientId(clientId);
    if (!owner) {
      // Unknown clientId — not one of our users. 400 rather than 200 so
      // SnapTrade's delivery logs surface the mismatch, but never touch
      // local state for an unresolvable event.
      res.sendStatus(HttpStatus.BAD_REQUEST);
      return;
    }
    const stored = await this.credentials.getDecrypted(
      owner.userId,
      'snaptrade',
      owner.environment,
    );
    if (!stored || stored.provider !== 'snaptrade') {
      res.sendStatus(HttpStatus.BAD_REQUEST);
      return;
    }

    const signedContent = canonicalJson(body);
    const expected = createHmac('sha256', stored.consumerKey)
      .update(signedContent)
      .digest('base64');
    const actual = Buffer.from(signature);
    if (
      actual.length !== Buffer.from(expected).length ||
      !timingSafeEqual(actual, Buffer.from(expected))
    ) {
      res.sendStatus(HttpStatus.UNAUTHORIZED);
      return;
    }

    const eventType = typeof body['eventType'] === 'string' ? (body['eventType'] as string) : '';

    try {
      await this.dispatch(eventType, owner.userId, owner.environment, body);
    } catch {
      // Log but still 2xx so SnapTrade stops retrying.
    }

    res.sendStatus(HttpStatus.OK);
  }

  private async dispatch(
    eventType: string,
    userId: string,
    environment: TradingMode,
    event: Record<string, unknown>,
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
        await this.handleTradeUpdate(userId, event);
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
    const connectionId =
      typeof event['brokerageAuthorizationId'] === 'string'
        ? (event['brokerageAuthorizationId'] as string)
        : '';
    if (!connectionId) return;
    const accounts = Array.isArray(event['accounts'])
      ? (event['accounts'] as Array<{ id?: string }>)
      : [];
    const accountIds = accounts
      .map((a) => a.id)
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
      update: {
        connectionId,
        accountIds,
        status: 'active',
      },
    });
  }

  private async handleConnectionBroken(
    userId: string,
    environment: TradingMode,
    event: Record<string, unknown>,
  ): Promise<void> {
    const connectionId =
      typeof event['brokerageAuthorizationId'] === 'string'
        ? (event['brokerageAuthorizationId'] as string)
        : '';
    if (!connectionId) return;
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
    const connectionId =
      typeof event['brokerageAuthorizationId'] === 'string'
        ? (event['brokerageAuthorizationId'] as string)
        : '';
    const accountId = typeof event['accountId'] === 'string' ? (event['accountId'] as string) : '';
    if (!connectionId || !accountId) return;
    await this.prisma.brokerConnection.updateMany({
      where: { userId, provider: 'snaptrade', environment, connectionId },
      data: { accountIds: { push: accountId } },
    });
  }

  private async handleTradeUpdate(userId: string, event: Record<string, unknown>): Promise<void> {
    const details = event['details'] as Record<string, unknown> | undefined;
    const orders = Array.isArray(details?.['orders'])
      ? (details['orders'] as Array<Record<string, unknown>>)
      : [];
    const order = orders[0];
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
    filledAt?: string;
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
      filledAt:
        typeof order['time_executed'] === 'string' ? (order['time_executed'] as string) : undefined,
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
    const legs = Array.isArray(order['legs'])
      ? (order['legs'] as Array<Record<string, unknown>>)
      : [];
    const instrument = legs[0]?.['instrument'] as Record<string, unknown> | undefined;
    if (instrument?.['symbol'] && typeof instrument['symbol'] === 'string') {
      return instrument['symbol'] as string;
    }
    const optionSymbol = order['option_symbol'] as Record<string, unknown> | undefined;
    if (optionSymbol?.['ticker'] && typeof optionSymbol['ticker'] === 'string') {
      return optionSymbol['ticker'] as string;
    }
    const universalSymbol = order['universal_symbol'] as Record<string, unknown> | undefined;
    if (universalSymbol?.['symbol'] && typeof universalSymbol['symbol'] === 'string') {
      return universalSymbol['symbol'] as string;
    }
    return '';
  }
}
