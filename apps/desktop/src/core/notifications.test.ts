import { beforeEach, describe, expect, it } from 'vitest';
import type { ChartOrder, OrderResult, OrderStatus } from '@0dtetrader/shared-types';
import type { NotifierDeps } from './notifications';
import { notifyChartOrder, notifyOrderUpdate } from './notifications';

let shown: Array<{ title: string; body?: string }> = [];

class FakeNotification {
  constructor(title: string, options?: { body?: string }) {
    shown.push({ title, body: options?.body });
  }
}

function deps(overrides: Partial<NotifierDeps> = {}): NotifierDeps {
  return {
    enabled: () => true,
    hasFocus: () => false,
    notification: FakeNotification,
    ...overrides,
  };
}

function orderUpdate(status: OrderStatus): OrderResult {
  return {
    orderId: 'o1',
    status,
    contractSymbol: 'SPY260808C00500000',
    side: 'buy',
    quantity: 2,
    orderType: 'mid',
    timestamp: '2026-08-02T14:30:00Z',
  };
}

function chartOrder(status: ChartOrder['status']): ChartOrder {
  return {
    id: 'c1',
    underlying: 'SPY',
    triggerPrice: 500.25,
    armPrice: 501,
    side: 'sell',
    quantity: 1,
    orderType: 'mid',
    kind: 'stop',
    optionType: 'call',
    expiration: '2026-08-08',
    strike: 500,
    contractSymbol: 'SPY260808C00500000',
    ocoGroupId: null,
    status,
    createdAt: '2026-08-02T14:00:00Z',
    expiresAt: '2026-08-08T20:00:00Z',
    triggeredAt: null,
    brokerOrderId: null,
    lastError: null,
  };
}

beforeEach(() => {
  shown = [];
});

describe('notifyOrderUpdate', () => {
  it('fires for each terminal status', () => {
    for (const status of ['filled', 'rejected', 'cancelled'] as const) {
      expect(notifyOrderUpdate(deps(), orderUpdate(status))).toBe(true);
    }
    expect(shown).toHaveLength(3);
    expect(shown[0]).toEqual({ title: 'Order filled', body: 'BUY 2 SPY260808C00500000' });
  });

  it('stays silent for non-terminal statuses', () => {
    for (const status of ['submitted', 'partially_filled'] as const) {
      expect(notifyOrderUpdate(deps(), orderUpdate(status))).toBe(false);
    }
    expect(shown).toHaveLength(0);
  });

  it('stays silent while the window has focus (the toast covers it)', () => {
    expect(notifyOrderUpdate(deps({ hasFocus: () => true }), orderUpdate('filled'))).toBe(false);
    expect(shown).toHaveLength(0);
  });

  it('stays silent when the preference is off', () => {
    expect(notifyOrderUpdate(deps({ enabled: () => false }), orderUpdate('filled'))).toBe(false);
    expect(shown).toHaveLength(0);
  });

  it('tolerates a platform without the Notification API', () => {
    expect(notifyOrderUpdate(deps({ notification: null }), orderUpdate('filled'))).toBe(false);
  });
});

describe('notifyChartOrder', () => {
  it('fires when a line triggers or fails', () => {
    expect(notifyChartOrder(deps(), chartOrder('triggered'))).toBe(true);
    expect(notifyChartOrder(deps(), chartOrder('failed'))).toBe(true);
    expect(shown).toEqual([
      { title: 'Chart order triggered', body: 'SPY crossed 500.25' },
      { title: 'Chart order failed', body: 'SPY crossed 500.25' },
    ]);
  });

  it('stays silent for every other line status', () => {
    for (const status of ['working', 'filled', 'cancelled', 'expired'] as const) {
      expect(notifyChartOrder(deps(), chartOrder(status))).toBe(false);
    }
    expect(shown).toHaveLength(0);
  });

  it('respects the enabled and focus gates', () => {
    expect(notifyChartOrder(deps({ enabled: () => false }), chartOrder('triggered'))).toBe(false);
    expect(notifyChartOrder(deps({ hasFocus: () => true }), chartOrder('triggered'))).toBe(false);
    expect(shown).toHaveLength(0);
  });
});
