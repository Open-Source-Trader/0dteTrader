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

function makeCredentials(opts?: { noOwner?: boolean; consumerKey?: string }) {
  return {
    findUserBySnapTradeClientId: jest.fn(async (clientId: string) => {
      if (opts?.noOwner) return null;
      if (clientId !== CLIENT_ID) return null;
      return { userId: OWNER_USER_ID, environment: 'live' as const };
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
  } as any;
}

function makeResponse() {
  const status = jest.fn(() => response);
  const sendStatus = jest.fn();
  const response = { status, sendStatus } as unknown as Response;
  return { response, status, sendStatus };
}

function headersFor(body: Record<string, unknown>, key = CONSUMER_KEY) {
  return {
    signature: sign(body, key),
    eventtimestamp: new Date().toISOString(),
  };
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

    it('returns 400 when eventtimestamp header is missing', async () => {
      const { response, sendStatus } = makeResponse();
      await controller.handle(
        { body: { clientId: CLIENT_ID }, headers: { signature: 'sig' } } as any,
        response,
      );
      expect(sendStatus).toHaveBeenCalledWith(400);
    });

    it('returns 400 when clientId is missing from the payload', async () => {
      const body = { eventType: 'TRADE_UPDATE' };
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(400);
    });

    it('returns 400 when no stored user matches the clientId', async () => {
      credentials = makeCredentials({ noOwner: true });
      controller = new SnapTradeWebhookController(credentials, prisma, events);
      const body = { eventType: 'TRADE_UPDATE', clientId: CLIENT_ID };
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(400);
    });

    it('returns 401 when signature does not match the owning user consumerKey', async () => {
      const body = { eventType: 'TRADE_UPDATE', clientId: CLIENT_ID };
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

    it('returns 400 when eventTimestamp is too old (replay guard)', async () => {
      const oldTimestamp = new Date(Date.now() - 1000 * 60 * 6).toISOString(); // 6 minutes ago
      const body = { eventType: 'TRADE_UPDATE', clientId: CLIENT_ID };
      const { response, sendStatus } = makeResponse();
      await controller.handle(
        {
          body,
          headers: { signature: sign(body), eventtimestamp: oldTimestamp },
        } as any,
        response,
      );
      expect(sendStatus).toHaveBeenCalledWith(400);
    });

    it('returns 400 when eventTimestamp is in the future', async () => {
      const futureTimestamp = new Date(Date.now() + 1000 * 60 * 6).toISOString(); // 6 minutes future
      const body = { eventType: 'TRADE_UPDATE', clientId: CLIENT_ID };
      const { response, sendStatus } = makeResponse();
      await controller.handle(
        {
          body,
          headers: { signature: sign(body), eventtimestamp: futureTimestamp },
        } as any,
        response,
      );
      expect(sendStatus).toHaveBeenCalledWith(400);
    });

    it('verifies the signature against sorted-key canonical JSON regardless of body key order', async () => {
      // Express/body-parser preserves insertion order; SnapTrade signs
      // sorted-key canonical JSON. A body whose keys arrive in a different
      // order than they'd sort to must still verify.
      const body = { clientId: CLIENT_ID, eventType: 'UNKNOWN_EVENT', accountId: 'acc-9' };
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
    });
  });

  describe('successful handling', () => {
    it('returns 200 for unknown event types', async () => {
      const body = { eventType: 'UNKNOWN_EVENT', clientId: CLIENT_ID };
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(prisma.brokerConnection.upsert).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('returns 200 even when dispatch throws', async () => {
      const body = { eventType: 'TRADE_UPDATE', clientId: CLIENT_ID, details: null as any };
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
    });
  });

  describe('CONNECTION_ADDED', () => {
    it('upserts brokerConnection with accounts, keyed by the resolved owner userId', async () => {
      const body = {
        eventType: 'CONNECTION_ADDED',
        clientId: CLIENT_ID,
        brokerageAuthorizationId: 'conn-1',
        accounts: [{ id: 'acc-1' }, { id: 'acc-2' }],
      };
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(prisma.brokerConnection.upsert).toHaveBeenCalledWith({
        where: { userId_provider: { userId: OWNER_USER_ID, provider: 'snaptrade' } },
        create: {
          userId: OWNER_USER_ID,
          provider: 'snaptrade',
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

    it('ignores CONNECTION_ADDED when brokerageAuthorizationId is missing', async () => {
      const body = {
        eventType: 'CONNECTION_ADDED',
        clientId: CLIENT_ID,
        accounts: [{ id: 'acc-1' }],
      };
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(prisma.brokerConnection.upsert).not.toHaveBeenCalled();
    });
  });

  describe('CONNECTION_BROKEN', () => {
    it('marks connection as broken', async () => {
      const body = {
        eventType: 'CONNECTION_BROKEN',
        clientId: CLIENT_ID,
        brokerageAuthorizationId: 'conn-1',
      };
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(prisma.brokerConnection.updateMany).toHaveBeenCalledWith({
        where: { userId: OWNER_USER_ID, provider: 'snaptrade', connectionId: 'conn-1' },
        data: { status: 'broken' },
      });
    });
  });

  describe('NEW_ACCOUNT_AVAILABLE', () => {
    it('appends accountId to connection', async () => {
      const body = {
        eventType: 'NEW_ACCOUNT_AVAILABLE',
        clientId: CLIENT_ID,
        brokerageAuthorizationId: 'conn-1',
        accountId: 'acc-3',
      };
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(prisma.brokerConnection.updateMany).toHaveBeenCalledWith({
        where: { userId: OWNER_USER_ID, provider: 'snaptrade', connectionId: 'conn-1' },
        data: { accountIds: { push: 'acc-3' } },
      });
    });
  });

  describe('TRADE_UPDATE / TRADE_DETECTION', () => {
    it('maps order status and emits via OrderEventsService', async () => {
      const body = {
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
      };
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(events.emit).toHaveBeenCalledWith(OWNER_USER_ID, {
        orderId: 'broker-1',
        status: 'filled',
        contractSymbol: 'SPY 250621C00503000',
        side: 'buy',
        quantity: 2,
        orderType: 'mid',
        limitPrice: 5.5,
        filledPrice: 5.6,
        filledQuantity: 2,
        timestamp: '2026-07-20T12:00:00Z',
      });
    });

    it('defaults missing fields safely', async () => {
      const body = {
        eventType: 'TRADE_UPDATE',
        clientId: CLIENT_ID,
        details: { orders: [{}] },
      };
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(events.emit).toHaveBeenCalledWith(OWNER_USER_ID, {
        orderId: '',
        status: 'submitted',
        contractSymbol: '',
        side: 'buy',
        quantity: 0,
        orderType: 'mid',
        timestamp: expect.any(String),
      });
    });

    it('does nothing when details.orders is empty', async () => {
      const body = {
        eventType: 'TRADE_DETECTION',
        clientId: CLIENT_ID,
        details: { orders: [] },
      };
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body, headers: headersFor(body) } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(events.emit).not.toHaveBeenCalled();
    });
  });
});
