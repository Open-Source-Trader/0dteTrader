import { describe, expect, it } from 'vitest';
import { tradeHistoryKey } from './tradeHistoryKey';

describe('tradeHistoryKey', () => {
  it('uses the app-owned identity when a current server provides it', () => {
    expect(
      tradeHistoryKey(
        {
          internalOrderId: 'internal-uuid',
          orderId: 'broker-id',
          timestamp: '2026-08-05T12:00:00Z',
        },
        0,
      ),
    ).toBe('internal-uuid');
  });

  it('falls back for history payloads returned by an older server', () => {
    expect(tradeHistoryKey({ orderId: 'broker-id', timestamp: '2026-08-05T12:00:00Z' }, 2)).toBe(
      'broker-id:2026-08-05T12:00:00Z:2',
    );
  });
});
