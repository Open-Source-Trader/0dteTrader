import { Response } from 'express';
import { createHmac } from 'node:crypto';

import { SnapTradeWebhookController } from './snaptrade-webhook.controller';

const CONSUMER_KEY = 'test-webhook-key';

function makeConfig(consumerKey = CONSUMER_KEY) {
  return {
    get: jest.fn((key: string) => {
      if (key === 'snaptrade.webhookConsumerKey') return consumerKey;
      if (key === 'snaptrade.consumerKey') return consumerKey;
      return undefined;
    }),
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

function sign(body: string, key = CONSUMER_KEY): string {
  return createHmac('sha256', key).update(body).digest('base64');
}

function makeResponse() {
  const status = jest.fn(() => response);
  const sendStatus = jest.fn();
  const response = { status, sendStatus } as unknown as Response;
  return { response, status, sendStatus };
}

describe('SnapTradeWebhookController', () => {
  let controller: SnapTradeWebhookController;
  let config: ReturnType<typeof makeConfig>;
  let prisma: ReturnType<typeof makePrisma>;
  let events: ReturnType<typeof makeEvents>;

  beforeEach(() => {
    config = makeConfig();
    prisma = makePrisma();
    events = makeEvents();
    controller = new SnapTradeWebhookController(config, prisma, events);
  });

  describe('validation / authentication', () => {
    it('returns 400 when signature header is missing', async () => {
      const { response, sendStatus } = makeResponse();
      await controller.handle(
        { body: {}, headers: { eventtimestamp: new Date().toISOString() } } as any,
        response,
      );
      expect(sendStatus).toHaveBeenCalledWith(400);
    });

    it('returns 400 when eventtimestamp header is missing', async () => {
      const { response, sendStatus } = makeResponse();
      await controller.handle({ body: {}, headers: { signature: 'sig' } } as any, response);
      expect(sendStatus).toHaveBeenCalledWith(400);
    });

    it('returns 400 when consumerKey is not configured', async () => {
      const noKeyConfig = makeConfig(undefined);
      const ctrl = new SnapTradeWebhookController(noKeyConfig, prisma, events);
      const { response, sendStatus } = makeResponse();
      await ctrl.handle(
        {
          body: {},
          headers: {
            signature: sign(JSON.stringify({})),
            eventtimestamp: new Date().toISOString(),
          },
        } as any,
        response,
      );
      expect(sendStatus).toHaveBeenCalledWith(400);
    });

    it('returns 401 when signature does not match', async () => {
      const { response, sendStatus } = makeResponse();
      await controller.handle(
        {
          body: {},
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
      const body = { event: 'TRADE_UPDATE', userId: 'u1' };
      const { response, sendStatus } = makeResponse();
      await controller.handle(
        {
          body,
          headers: {
            signature: sign(JSON.stringify(body)),
            eventtimestamp: oldTimestamp,
          },
        } as any,
        response,
      );
      expect(sendStatus).toHaveBeenCalledWith(400);
    });

    it('returns 400 when eventTimestamp is in the future', async () => {
      const futureTimestamp = new Date(Date.now() + 1000 * 60 * 6).toISOString(); // 6 minutes future
      const body = { event: 'TRADE_UPDATE', userId: 'u1' };
      const { response, sendStatus } = makeResponse();
      await controller.handle(
        {
          body,
          headers: {
            signature: sign(JSON.stringify(body)),
            eventtimestamp: futureTimestamp,
          },
        } as any,
        response,
      );
      expect(sendStatus).toHaveBeenCalledWith(400);
    });

    it('returns 400 when userId is missing', async () => {
      const body = { event: 'TRADE_UPDATE' };
      const { response, sendStatus } = makeResponse();
      await controller.handle(
        {
          body,
          headers: {
            signature: sign(JSON.stringify(body)),
            eventtimestamp: new Date().toISOString(),
          },
        } as any,
        response,
      );
      expect(sendStatus).toHaveBeenCalledWith(400);
    });
  });

  describe('successful handling', () => {
    let response: Response;
    let sendStatus: jest.Mock;

    beforeEach(() => {
      const made = makeResponse();
      response = made.response;
      sendStatus = made.sendStatus;
    });

    it('returns 200 for unknown event types', async () => {
      const body = { event: 'UNKNOWN_EVENT', userId: 'u1' };
      await controller.handle(
        {
          body,
          headers: {
            signature: sign(JSON.stringify(body)),
            eventtimestamp: new Date().toISOString(),
          },
        } as any,
        response,
      );
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(prisma.brokerConnection.upsert).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('returns 200 even when dispatch throws', async () => {
      const body = { event: 'TRADE_UPDATE', userId: 'u1', order: null as any };
      await controller.handle(
        {
          body,
          headers: {
            signature: sign(JSON.stringify(body)),
            eventtimestamp: new Date().toISOString(),
          },
        } as any,
        response,
      );
      expect(sendStatus).toHaveBeenCalledWith(200);
    });
  });

  describe('CONNECTION_ADDED', () => {
    it('upserts brokerConnection with accounts', async () => {
      const body = {
        event: 'CONNECTION_ADDED',
        userId: 'u1',
        connectionId: 'conn-1',
        accounts: [{ id: 'acc-1' }, { id: 'acc-2' }],
      };
      const { response, sendStatus } = makeResponse();
      await controller.handle(
        {
          body,
          headers: {
            signature: sign(JSON.stringify(body)),
            eventtimestamp: new Date().toISOString(),
          },
        } as any,
        response,
      );
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(prisma.brokerConnection.upsert).toHaveBeenCalledWith({
        where: { userId_provider: { userId: 'u1', provider: 'snaptrade' } },
        create: {
          userId: 'u1',
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

    it('ignores CONNECTION_ADDED when connectionId is missing', async () => {
      const body = {
        event: 'CONNECTION_ADDED',
        userId: 'u1',
        accounts: [{ id: 'acc-1' }],
      };
      const { response, sendStatus } = makeResponse();
      await controller.handle(
        {
          body,
          headers: {
            signature: sign(JSON.stringify(body)),
            eventtimestamp: new Date().toISOString(),
          },
        } as any,
        response,
      );
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(prisma.brokerConnection.upsert).not.toHaveBeenCalled();
    });
  });

  describe('CONNECTION_BROKEN', () => {
    it('marks connection as broken', async () => {
      const body = {
        event: 'CONNECTION_BROKEN',
        userId: 'u1',
        connectionId: 'conn-1',
      };
      const { response, sendStatus } = makeResponse();
      await controller.handle(
        {
          body,
          headers: {
            signature: sign(JSON.stringify(body)),
            eventtimestamp: new Date().toISOString(),
          },
        } as any,
        response,
      );
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(prisma.brokerConnection.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', provider: 'snaptrade', connectionId: 'conn-1' },
        data: { status: 'broken' },
      });
    });
  });

  describe('NEW_ACCOUNT_AVAILABLE', () => {
    it('appends accountId to connection', async () => {
      const body = {
        event: 'NEW_ACCOUNT_AVAILABLE',
        userId: 'u1',
        connectionId: 'conn-1',
        accountId: 'acc-3',
      };
      const { response, sendStatus } = makeResponse();
      await controller.handle(
        {
          body,
          headers: {
            signature: sign(JSON.stringify(body)),
            eventtimestamp: new Date().toISOString(),
          },
        } as any,
        response,
      );
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(prisma.brokerConnection.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', provider: 'snaptrade', connectionId: 'conn-1' },
        data: { accountIds: { push: 'acc-3' } },
      });
    });
  });

  describe('TRADE_UPDATE / TRADE_DETECTION', () => {
    it('maps order status and emits via OrderEventsService', async () => {
      const body = {
        event: 'TRADE_UPDATE',
        userId: 'u1',
        order: {
          brokerage_order_id: 'broker-1',
          status: 'EXECUTED',
          total_quantity: '2',
          action: 'BUY_TO_OPEN',
          order_type: 'LIMIT',
          limit_price: '5.50',
          execution_price: '5.60',
          filled_quantity: '2',
          time_placed: '2026-07-20T12:00:00Z',
          option_symbol: { ticker: 'SPY 250621C00503000' },
        },
      };
      const { response, sendStatus } = makeResponse();
      await controller.handle(
        {
          body,
          headers: {
            signature: sign(JSON.stringify(body)),
            eventtimestamp: new Date().toISOString(),
          },
        } as any,
        response,
      );
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(events.emit).toHaveBeenCalledWith('u1', {
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

    it('reads order from trade field when order is absent', async () => {
      const body = {
        event: 'TRADE_DETECTION',
        userId: 'u1',
        trade: {
          brokerage_order_id: 'broker-2',
          status: 'PARTIALLY_FILLED',
          total_quantity: '5',
          action: 'SELL_TO_CLOSE',
          order_type: 'MARKET',
          filled_quantity: '2',
          time_placed: '2026-07-20T12:00:00Z',
          universal_symbol: { symbol: 'SPY 250621P00495000' },
        },
      };
      const { response, sendStatus } = makeResponse();
      await controller.handle(
        {
          body,
          headers: {
            signature: sign(JSON.stringify(body)),
            eventtimestamp: new Date().toISOString(),
          },
        } as any,
        response,
      );
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(events.emit).toHaveBeenCalledWith('u1', {
        orderId: 'broker-2',
        status: 'partially_filled',
        contractSymbol: 'SPY 250621P00495000',
        side: 'sell',
        quantity: 5,
        orderType: 'market',
        filledQuantity: 2,
        timestamp: '2026-07-20T12:00:00Z',
      });
    });

    it('defaults missing fields safely', async () => {
      const body = {
        event: 'TRADE_UPDATE',
        userId: 'u1',
        order: {},
      };
      const { response, sendStatus } = makeResponse();
      await controller.handle(
        {
          body,
          headers: {
            signature: sign(JSON.stringify(body)),
            eventtimestamp: new Date().toISOString(),
          },
        } as any,
        response,
      );
      expect(sendStatus).toHaveBeenCalledWith(200);
      expect(events.emit).toHaveBeenCalledWith('u1', {
        orderId: '',
        status: 'submitted',
        contractSymbol: '',
        side: 'buy',
        quantity: 0,
        orderType: 'mid',
        timestamp: expect.any(String),
      });
    });
  });
});
