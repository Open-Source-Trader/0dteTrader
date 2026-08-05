import { Response } from 'express';
import { createHmac } from 'node:crypto';

import { SnapTradeWebhookController } from './snaptrade-webhook.controller';

const CONSUMER_KEY = 'test-webhook-key';
const CLIENT_ID = 'client-abc';
const OWNER_USER_ID = 'u1';

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as any)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sign(body: unknown, key = CONSUMER_KEY): string {
  return createHmac('sha256', key).update(canonicalJson(body)).digest('base64');
}

function makeCredentials(opts?: {
  noOwner?: boolean;
  consumerKey?: string;
  environment?: 'live' | 'practice';
}) {
  return {
    findUserBySnapTradeClientId: jest.fn(async (clientId: string) => {
      if (opts?.noOwner) return null;
      if (clientId !== CLIENT_ID) return null;
      return { userId: OWNER_USER_ID, environment: opts?.environment ?? ('live' as const) };
    }),
    getDecrypted: jest.fn(async () => ({
      provider: 'snaptrade' as const,
      clientId: CLIENT_ID,
      consumerKey: opts?.consumerKey ?? CONSUMER_KEY,
    })),
  } as any;
}

function makePrisma() {
  const brokerConnection = {
    upsert: jest.fn(),
    updateMany: jest.fn(),
  };
  return {
    brokerConnection,
  } as any;
}

function makeEvents() {
  return {
    emit: jest.fn(),
    ingest: jest.fn(async () => undefined),
  } as any;
}

function makeResponse() {
  const status = jest.fn(() => response);
  const sendStatus = jest.fn();
  const response = { status, sendStatus } as unknown as Response;
  return { response, status, sendStatus };
}

/** Signs the EXACT body under test — fixtures must put eventTimestamp INTO
 *  the body before signing, the way SnapTrade does; there is no timestamp
 *  header. */
function headersFor(body: Record<string, unknown>, key = CONSUMER_KEY) {
  return { signature: sign(body, key) };
}

/** A body the way SnapTrade sends it: signed fields include the timestamp. */
function stamped(body: Record<string, unknown>): Record<string, unknown> {
  return { eventTimestamp: new Date().toISOString(), ...body };
}

describe('SnapTradeWebhookController', () => {
  let controller: SnapTradeWebhookController;
  let credentials: ReturnType<typeof makeCredentials>;
  let prisma: ReturnType<typeof makePrisma>;
  let events: ReturnType<typeof makeEvents>;

  beforeEach(() => {
    credentials = makeCredentials();
    prisma = makePrisma();
    events = makeEvents();
    controller = new SnapTradeWebhookController(credentials, prisma, events);
  });

  describe('validation / authentication', () => {
    it('returns 400 when signature header is missing', async () => {
      const { response, sendStatus } = makeResponse();
      await controller.handle(
        {
          body: { clientId: CLIENT_ID },
          headers: { eventtimestamp: new Date().toISOString() },
        } as any,
        response,
      );
      expect(sendStatus).toHaveBeenCalledWith(400);
    });

    it('returns 400 when the payload carries no timestamp anywhere', async () => {
      const { response, sendStatus } = makeResponse();
      await controller.handle(
        { body: { clientId: CLIENT_ID }, headers: { signature: 'sig' } } as any,
        response,
      );
      expect(sendStatus).toHaveBeenCalledWith(400);
    });

    it('returns 400 when clientId is missing from the payload', async () => {
      const body = stamped({ eventType: 'TRADE_UPDATE' });
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(400);
    });

    it('returns 400 when no stored user matches the clientId', async () => {
      credentials = makeCredentials({ noOwner: true });
      controller = new SnapTradeWebhookController(credentials, prisma, events);
      const body = stamped({ eventType: 'TRADE_UPDATE', clientId: CLIENT_ID });
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(400);
    });

    it('returns 401 when signature does not match the owning user consumerKey', async () => {
      const body = stamped({ eventType: 'TRADE_UPDATE', clientId: CLIENT_ID });
      const { response, sendStatus } = makeResponse();
      await controller.handle(
        {
          body,
          headers: {
            signature: 'invalid-signature',
            eventtimestamp: new Date().toISOString(),
          },
        } as any,
        response,
      );
      expect(sendStatus).toHaveBeenCalledWith(401);
    });

    it('accepts a delayed retry, which SnapTrade sends on 30-minute backoff', async () => {
      const body = stamped({
        eventType: 'TRADE_UPDATE',
        clientId: CLIENT_ID,
        eventTimestamp: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
      });
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: { signature: sign(body) } } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
    });

    it('reads freshness from the SIGNED payload, so a fresh header cannot revive a stale body', async () => {
      // The replay: a captured (body, signature) pair re-sent with a
      // just-now header. The header is not covered by the HMAC, so it must
      // not be able to vouch for the payload's age.
      const body = stamped({
        eventType: 'TRADE_UPDATE',
        clientId: CLIENT_ID,
        eventTimestamp: new Date(Date.now() - 1000 * 60 * 60 * 25).toISOString(),
      });
      const { response, sendStatus } = makeResponse();
      await controller.handle(
        {
          body,
          headers: { signature: sign(body), eventtimestamp: new Date().toISOString() },
        } as any,
        response,
      );
      expect(sendStatus).toHaveBeenCalledWith(400);
    });

    it('accepts a payload with no timestamp header — the signed body field is the only source', async () => {
      const body = stamped({
        eventType: 'TRADE_UPDATE',
        clientId: CLIENT_ID,
        eventTimestamp: new Date().toISOString(),
      });
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: { signature: sign(body) } } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
    });

    it('returns 400 when the signed eventTimestamp is too old (replay guard)', async () => {
      const body = {
        eventType: 'TRADE_UPDATE',
        clientId: CLIENT_ID,
        eventTimestamp: new Date(Date.now() - 1000 * 60 * 60 * 25).toISOString(),
      };
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(400);
    });

    it('returns 400 when the signed eventTimestamp sits beyond the future skew allowance', async () => {
      // 6 minutes ahead: past the 5-minute clock-skew allowance. A future
      // stamp has no retry ladder to clear, so the window is tight.
      const body = {
        eventType: 'TRADE_UPDATE',
        clientId: CLIENT_ID,
        eventTimestamp: new Date(Date.now() + 1000 * 60 * 6).toISOString(),
      };
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(400);
    });

    it('tolerates ordinary future clock skew', async () => {
      const body = {
        eventType: 'TRADE_UPDATE',
        clientId: CLIENT_ID,
        eventTimestamp: new Date(Date.now() + 1000 * 60).toISOString(),
      };
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
    });

    it('returns 400 when eventTimestamp is not a string, even under a fresh header', async () => {
      // The header is unsigned and must never vouch for the payload's age.
      const body = { eventType: 'TRADE_UPDATE', clientId: CLIENT_ID, eventTimestamp: 12345 };
      const { response, sendStatus } = makeResponse();
      await controller.handle(
        {
          body,
          headers: { signature: sign(body), eventtimestamp: new Date().toISOString() },
        } as any,
        response,
      );
      expect(sendStatus).toHaveBeenCalledWith(400);
    });

    it('verifies the signature against sorted-key canonical JSON regardless of body key order', async () => {
      // Express/body-parser preserves insertion order; SnapTrade signs
      // sorted-key canonical JSON. A body whose keys arrive in a different
      // order than they'd sort to must still verify.
      const body = stamped({ clientId: CLIENT_ID, eventType: 'UNKNOWN_EVENT', accountId: 'acc-9' });
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
    });
  });

  describe('successful handling', () => {
    it('returns 200 for unknown event types', async () => {
      const body = stamped({ eventType: 'UNKNOWN_EVENT', clientId: CLIENT_ID });
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(prisma.brokerConnection.upsert).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('returns 200 even when dispatch throws', async () => {
      const body = stamped({
        eventType: 'TRADE_UPDATE',
        clientId: CLIENT_ID,
        details: null as any,
      });
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
    });
  });

  describe('CONNECTION_ADDED', () => {
    it('upserts brokerConnection with accounts, keyed by the resolved owner userId', async () => {
      const body = stamped({
        eventType: 'CONNECTION_ADDED',
        clientId: CLIENT_ID,
        brokerageAuthorizationId: 'conn-1',
        accounts: [{ id: 'acc-1' }, { id: 'acc-2' }],
      });
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(prisma.brokerConnection.upsert).toHaveBeenCalledWith({
        where: {
          userId_provider_environment: {
            userId: OWNER_USER_ID,
            provider: 'snaptrade',
            environment: 'live',
          },
        },
        create: {
          userId: OWNER_USER_ID,
          provider: 'snaptrade',
          environment: 'live',
          connectionId: 'conn-1',
          accountIds: ['acc-1', 'acc-2'],
          selectedAccountId: 'acc-1',
          status: 'active',
        },
        update: {
          connectionId: 'conn-1',
          accountIds: ['acc-1', 'acc-2'],
          status: 'active',
        },
      });
    });

    it('upserts against the practice row when the resolved owner is in practice mode', async () => {
      credentials = makeCredentials({ environment: 'practice' });
      controller = new SnapTradeWebhookController(credentials, prisma, events);
      const body = stamped({
        eventType: 'CONNECTION_ADDED',
        clientId: CLIENT_ID,
        brokerageAuthorizationId: 'conn-practice',
        accounts: [{ id: 'acc-1' }],
      });
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(prisma.brokerConnection.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId_provider_environment: {
              userId: OWNER_USER_ID,
              provider: 'snaptrade',
              environment: 'practice',
            },
          },
          create: expect.objectContaining({ environment: 'practice' }),
        }),
      );
    });

    it('ignores CONNECTION_ADDED when brokerageAuthorizationId is missing', async () => {
      const body = stamped({
        eventType: 'CONNECTION_ADDED',
        clientId: CLIENT_ID,
        accounts: [{ id: 'acc-1' }],
      });
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(prisma.brokerConnection.upsert).not.toHaveBeenCalled();
    });
  });

  describe('CONNECTION_BROKEN', () => {
    it('marks connection as broken', async () => {
      const body = stamped({
        eventType: 'CONNECTION_BROKEN',
        clientId: CLIENT_ID,
        brokerageAuthorizationId: 'conn-1',
      });
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(prisma.brokerConnection.updateMany).toHaveBeenCalledWith({
        where: {
          userId: OWNER_USER_ID,
          provider: 'snaptrade',
          environment: 'live',
          connectionId: 'conn-1',
        },
        data: { status: 'broken' },
      });
    });
  });

  describe('NEW_ACCOUNT_AVAILABLE', () => {
    it('appends accountId to connection', async () => {
      const body = stamped({
        eventType: 'NEW_ACCOUNT_AVAILABLE',
        clientId: CLIENT_ID,
        brokerageAuthorizationId: 'conn-1',
        accountId: 'acc-3',
      });
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(prisma.brokerConnection.updateMany).toHaveBeenCalledWith({
        where: {
          userId: OWNER_USER_ID,
          provider: 'snaptrade',
          environment: 'live',
          connectionId: 'conn-1',
          // Append-if-absent in one atomic statement: SnapTrade redelivers
          // webhooks, and an unconditional push duplicated the id each time.
          NOT: { accountIds: { has: 'acc-3' } },
        },
        data: { accountIds: { push: 'acc-3' } },
      });
    });
  });

  describe('NEW_ACCOUNT_AVAILABLE redelivery', () => {
    it('appends an account id at most once across redeliveries (append-if-absent)', async () => {
      // Real matcher semantics, not a jest.fn: the guarded where must skip a
      // connection that already holds the id.
      const rows = [
        {
          userId: OWNER_USER_ID,
          provider: 'snaptrade',
          environment: 'live',
          connectionId: 'conn-1',
          accountIds: ['acc-1'],
        },
      ];
      prisma.brokerConnection.updateMany = jest.fn(async ({ where, data }: any) => {
        const matched = rows.filter(
          (row) =>
            row.userId === where.userId &&
            row.connectionId === where.connectionId &&
            !(where.NOT && row.accountIds.includes(where.NOT.accountIds.has)),
        );
        for (const row of matched) row.accountIds.push(data.accountIds.push);
        return { count: matched.length };
      });
      const body = stamped({
        eventType: 'NEW_ACCOUNT_AVAILABLE',
        clientId: CLIENT_ID,
        brokerageAuthorizationId: 'conn-1',
        accountId: 'acc-2',
      });
      const { response } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      await controller.handle({ body, headers: headersFor(body) } as any, response);

      expect(rows[0].accountIds).toEqual(['acc-1', 'acc-2']);
    });
  });

  describe('TRADE_UPDATE / TRADE_DETECTION', () => {
    it('maps order status and emits via OrderEventsService', async () => {
      const body = stamped({
        eventType: 'TRADE_UPDATE',
        clientId: CLIENT_ID,
        details: {
          orders: [
            {
              brokerage_order_id: 'broker-1',
              status: 'EXECUTED',
              total_quantity: '2',
              action: 'BUY_TO_OPEN',
              order_type: 'LIMIT',
              limit_price: '5.50',
              execution_price: '5.60',
              filled_quantity: '2',
              time_placed: '2026-07-20T12:00:00Z',
              legs: [{ instrument: { symbol: 'SPY 250621C00503000' } }],
            },
          ],
        },
      });
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(events.ingest).toHaveBeenCalledWith(
        OWNER_USER_ID,
        {
          orderId: 'broker-1',
          status: 'filled',
          // SnapTrade sends the space-padded OCC; it is normalized to the
          // app's compact canonical form at this boundary.
          contractSymbol: 'SPY250621C00503000',
          side: 'buy',
          quantity: 2,
          orderType: 'mid',
          limitPrice: 5.5,
          filledPrice: 5.6,
          filledQuantity: 2,
          timestamp: '2026-07-20T12:00:00Z',
        },
        // The environment resolved from the credential the event was signed
        // with — not the user's current, mutable trading mode.
        'live',
      );
    });

    it('drops an order with no broker id rather than filing it under an empty key', async () => {
      // trade_orders is keyed by the broker's order id, so an id-less event
      // from ANY user would land on one shared row and a later fill would
      // mutate whoever got there first.
      const body = stamped({
        eventType: 'TRADE_UPDATE',
        clientId: CLIENT_ID,
        details: { orders: [{}] },
      });
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(events.ingest).not.toHaveBeenCalled();
    });

    it('emits every order in the payload, not just the first', async () => {
      // TRADE_DETECTION carries a list; a second fill in the same delivery
      // used to be discarded silently.
      const body = stamped({
        eventType: 'TRADE_DETECTION',
        clientId: CLIENT_ID,
        details: {
          orders: [
            { brokerage_order_id: 'broker-1', status: 'EXECUTED', total_quantity: '1' },
            { brokerage_order_id: 'broker-2', status: 'EXECUTED', total_quantity: '1' },
          ],
        },
      });
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(events.ingest).toHaveBeenCalledTimes(2);
      expect((events.ingest as jest.Mock).mock.calls.map((c) => c[1].orderId)).toEqual([
        'broker-1',
        'broker-2',
      ]);
    });

    it('normalizes a padded option_symbol ticker when the order has no legs', async () => {
      const body = stamped({
        eventType: 'TRADE_UPDATE',
        clientId: CLIENT_ID,
        details: {
          orders: [
            {
              brokerage_order_id: 'broker-pad',
              status: 'EXECUTED',
              total_quantity: '1',
              option_symbol: { ticker: 'AAPL  261218C00240000' },
            },
          ],
        },
      });
      const { response } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect((events.ingest as jest.Mock).mock.calls[0][1].contractSymbol).toBe(
        'AAPL261218C00240000',
      );
    });

    it('answers 5xx when ingestion fails, so SnapTrade retries — never a false 200', async () => {
      (events.ingest as jest.Mock).mockRejectedValueOnce(new Error('database down'));
      const body = stamped({
        eventType: 'TRADE_UPDATE',
        clientId: CLIENT_ID,
        details: {
          orders: [{ brokerage_order_id: 'broker-1', status: 'EXECUTED', total_quantity: '1' }],
        },
      });
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(500);
    });

    it('acknowledges only after ingestion resolved — persistence precedes the 200', async () => {
      let persisted = false;
      (events.ingest as jest.Mock).mockImplementationOnce(async () => {
        await new Promise((resolve) => setImmediate(resolve));
        persisted = true;
      });
      const body = stamped({
        eventType: 'TRADE_UPDATE',
        clientId: CLIENT_ID,
        details: {
          orders: [{ brokerage_order_id: 'broker-1', status: 'EXECUTED', total_quantity: '1' }],
        },
      });
      const { response, sendStatus } = makeResponse();
      const handled = controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).not.toHaveBeenCalled();
      await handled;
      expect(persisted).toBe(true);
      expect(sendStatus).toHaveBeenCalledWith(200);
    });

    it.each([
      ['PARTIAL_CANCELED', 'cancelled'],
      ['CANCEL_PENDING', 'submitted'],
    ])('maps %s to %s', async (brokerStatus, expected) => {
      // PARTIAL_CANCELED is terminal — the remainder was cancelled and
      // nothing more will execute. CANCEL_PENDING is a request, not an
      // outcome: the order is still live and can still fill.
      const body = stamped({
        eventType: 'TRADE_UPDATE',
        clientId: CLIENT_ID,
        details: {
          orders: [{ brokerage_order_id: 'broker-9', status: brokerStatus, total_quantity: '3' }],
        },
      });
      const { response } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect((events.ingest as jest.Mock).mock.calls[0][1].status).toBe(expected);
    });

    it('does nothing when details.orders is empty', async () => {
      const body = stamped({
        eventType: 'TRADE_DETECTION',
        clientId: CLIENT_ID,
        details: { orders: [] },
      });
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(events.emit).not.toHaveBeenCalled();
    });
  });
});
