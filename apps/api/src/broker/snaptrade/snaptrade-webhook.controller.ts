import { Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { TradingMode } from '@0dtetrader/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { CredentialsService } from '../../credentials/credentials.service';
import { OrderEventsService } from '../order-events.service';
import { compactOcc } from './snaptrade-mappers';

/** Freshness bound on a webhook's own `eventTimestamp`. Wide because
 *  SnapTrade retries a failed delivery on 30-minute exponential backoff for
 *  three tries: a window narrower than that ladder rejects the retries this
 *  endpoint exists to accept. It bounds how long a captured payload stays
 *  usable, nothing more. */
const MAX_REPLAY_DRIFT_MS = 24 * 60 * 60 * 1_000;

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
 * - Rejects payloads whose signed `eventTimestamp` is stale (see
 *   MAX_REPLAY_DRIFT_MS — the bound has to clear SnapTrade's own retry
 *   ladder, so it is coarse; exact-replay suppression comes from the
 *   idempotency downstream, not from this check).
 * - Always returns 2xx after dispatch (SnapTrade retries with 30-min
 *   exponential backoff, 3 tries). The 2xx is sent once the in-process
 *   handlers have run, which is NOT a durability boundary: an instance that
 *   dies mid-dispatch loses the event, since nothing stores the raw payload.
 *   Closing that needs a webhook inbox table — see the PR discussion.
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
    const body = (req.body ?? {}) as Record<string, unknown>;
    const clientId = typeof body['clientId'] === 'string' ? (body['clientId'] as string) : '';

    if (!signature || !clientId) {
      res.sendStatus(HttpStatus.BAD_REQUEST);
      return;
    }

    // Freshness is read from the SIGNED payload. SnapTrade documents
    // `eventTimestamp` as a body field and signs the body; it sends no
    // timestamp header, so requiring one rejected every genuine delivery,
    // and trusting one would have let a captured payload be replayed under a
    // fresh unsigned stamp. The header is still accepted as a fallback so a
    // deployment sending one does not regress.
    const timestampHeader = req.headers['eventtimestamp'] as string | undefined;
    const signedTimestamp =
      typeof body['eventTimestamp'] === 'string' ? (body['eventTimestamp'] as string) : undefined;
    const eventTimestamp = Date.parse(signedTimestamp ?? timestampHeader ?? '');
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
        await this.handleTradeUpdate(userId, environment, event);
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

  private async handleTradeUpdate(
    userId: string,
    environment: TradingMode,
    event: Record<string, unknown>,
  ): Promise<void> {
    const details = event['details'] as Record<string, unknown> | undefined;
    const orders = Array.isArray(details?.['orders'])
      ? (details['orders'] as Array<Record<string, unknown>>)
      : [];
    // Every order, not just the first: SnapTrade documents TRADE_DETECTION as
    // carrying a list, and a second fill in the same payload used to be
    // dropped silently. Downstream is already safe for N events — recording
    // serializes per order id and both the fill watermark and the push claim
    // are idempotent.
    for (const order of orders) {
      const mapped = this.mapOrderResult(order);
      // An order with no broker id has no identity: `id` is the primary key
      // of trade_orders, so every id-less event across every user would
      // collide on the same row, and a later fill would mutate someone
      // else's order. There is nothing safe to do with it but drop it.
      if (!mapped.orderId) continue;
      this.events.emit(userId, mapped, environment);
    }
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
    if (['PARTIAL', 'PARTIALLY_FILLED'].includes(s)) return 'partially_filled';
    // PARTIAL_CANCELED is TERMINAL: the unfilled remainder was cancelled and
    // nothing more will execute. Mapping it to partially_filled left the
    // order sitting in the working list forever and suppressed its terminal
    // push. The executed portion is still accounted — a cancelled row
    // carrying a filled quantity is a real fill to the position book.
    if (['CANCELED', 'CANCELLED', 'EXPIRED', 'PARTIAL_CANCELED'].includes(s)) return 'cancelled';
    if (['FAILED', 'REJECTED'].includes(s)) return 'rejected';
    // CANCEL_PENDING is a REQUEST, not an outcome: the order is still live
    // and can still fill. Reporting it as cancelled announced an outcome the
    // broker had not reached.
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
      return compactOcc(instrument['symbol'] as string);
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
