import { compactOcc, mapOrderStatus, toOrderResult } from './snaptrade-mappers';

/**
 * One provider-status table, asserted against the ONE mapper both ingestion
 * paths use: the webhook controller and REST polling (toOrderResult) import
 * mapOrderStatus, so the paths cannot drift apart — which they had, with the
 * REST side calling CANCEL_PENDING terminal and PARTIAL_CANCELED non-terminal.
 */
const STATUS_TABLE: Array<[string, string]> = [
  ['NONE', 'submitted'],
  ['PENDING', 'submitted'],
  ['ACCEPTED', 'submitted'],
  ['QUEUED', 'submitted'],
  ['TRIGGERED', 'submitted'],
  ['ACTIVATED', 'submitted'],
  ['REPLACE_PENDING', 'submitted'],
  ['REPLACED', 'submitted'],
  // A cancel REQUEST is not an outcome: the order is live and can still fill.
  ['CANCEL_PENDING', 'submitted'],
  ['EXECUTED', 'filled'],
  ['FILLED', 'filled'],
  ['PARTIAL', 'partially_filled'],
  ['PARTIALLY_FILLED', 'partially_filled'],
  ['CANCELED', 'cancelled'],
  ['CANCELLED', 'cancelled'],
  ['EXPIRED', 'cancelled'],
  // Terminal: the unfilled remainder is gone; the executed portion still
  // accounts via its filled quantity.
  ['PARTIAL_CANCELED', 'cancelled'],
  ['FAILED', 'rejected'],
  ['REJECTED', 'rejected'],
  ['SOMETHING_NEW', 'submitted'],
];

describe('SnapTrade status mapping (canonical, shared by webhook and REST)', () => {
  it.each(STATUS_TABLE)('%s → %s', (provider, app) => {
    expect(mapOrderStatus(provider)).toBe(app);
  });

  it('feeds the REST path (toOrderResult) from the same table', () => {
    const base = {
      brokerage_order_id: 'o-1',
      total_quantity: 1,
      action: 'BUY_TO_OPEN',
      order_type: 'LIMIT',
      time_placed: '2026-08-01T14:00:00Z',
    };
    expect(toOrderResult({ ...base, status: 'PARTIAL_CANCELED' } as never).status).toBe(
      'cancelled',
    );
    expect(toOrderResult({ ...base, status: 'CANCEL_PENDING' } as never).status).toBe('submitted');
  });
});

describe('compactOcc', () => {
  it('collapses SnapTrade’s padded OCC form to the app’s compact canonical form', () => {
    expect(compactOcc('AAPL  261218C00240000')).toBe('AAPL261218C00240000');
    expect(compactOcc('SPY250621C00503000')).toBe('SPY250621C00503000');
  });
});
