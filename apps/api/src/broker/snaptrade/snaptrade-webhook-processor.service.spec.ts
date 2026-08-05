import { SnapTradeWebhookProcessorService } from './snaptrade-webhook-processor.service';

const USER = '11111111-1111-4111-8111-111111111111';

function tradePayload(accountId?: string): Record<string, unknown> {
  return {
    ...(accountId ? { accountId } : {}),
    details: {
      orders: [
        {
          brokerage_order_id: 'broker-1',
          status: 'EXECUTED',
          total_quantity: '1',
          action: 'BUY_TO_OPEN',
          time_placed: '2026-08-05T14:30:00Z',
          legs: [{ instrument: { symbol: 'SPY  260807C00600000' } }],
        },
      ],
    },
  };
}

describe('SnapTradeWebhookProcessorService account scope', () => {
  const ingest = jest.fn(async () => undefined);
  const findUnique = jest.fn();
  const service = new SnapTradeWebhookProcessorService(
    { brokerConnection: { findUnique } } as never,
    { ingest } as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('infers a missing payload account only from a single-account connection', async () => {
    findUnique.mockResolvedValue({
      accountIds: [' account-only '],
      selectedAccountId: 'mutable-selection-is-irrelevant',
    });

    await service.process('TRADE_UPDATE', USER, 'live', tradePayload(), 'webhook-1');

    expect(ingest).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ orderId: 'broker-1' }),
      'live',
      expect.objectContaining({ provider: 'snaptrade', accountId: 'account-only' }),
    );
  });

  it('rejects an account-less payload when multiple accounts exist', async () => {
    findUnique.mockResolvedValue({
      accountIds: ['account-a', 'account-b'],
      selectedAccountId: 'account-a',
    });

    await expect(
      service.process('TRADE_UPDATE', USER, 'live', tradePayload(), 'webhook-ambiguous'),
    ).rejects.toThrow('multiple broker accounts exist');
    expect(ingest).not.toHaveBeenCalled();
  });

  it('rejects an account-less payload when no account is known', async () => {
    findUnique.mockResolvedValue(null);

    await expect(
      service.process('TRADE_UPDATE', USER, 'live', tradePayload(), 'webhook-unscoped'),
    ).rejects.toThrow('no broker account is known');
    expect(ingest).not.toHaveBeenCalled();
  });

  it('uses the account snapshotted into the inbox without consulting mutable connection state', async () => {
    findUnique.mockResolvedValue({ accountIds: ['account-a', 'account-b'] });

    await service.process(
      'TRADE_UPDATE',
      USER,
      'live',
      tradePayload(),
      'webhook-snapshotted',
      'account-at-receipt',
    );

    expect(findUnique).not.toHaveBeenCalled();
    expect(ingest).toHaveBeenCalledWith(
      USER,
      expect.any(Object),
      'live',
      expect.objectContaining({ accountId: 'account-at-receipt' }),
    );
  });

  it('does not reinterpret a null inbox snapshot after connection state later changes', async () => {
    findUnique.mockResolvedValue({ accountIds: ['account-added-later'] });

    await expect(
      service.process('TRADE_UPDATE', USER, 'live', tradePayload(), 'webhook-null-snapshot', null),
    ).rejects.toThrow('missing or ambiguous at receipt');

    expect(findUnique).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });
});
