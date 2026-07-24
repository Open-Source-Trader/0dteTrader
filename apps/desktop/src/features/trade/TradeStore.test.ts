import { describe, expect, it, vi } from 'vitest';
import type { OrderResult } from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import type { ChainStore } from './ChainStore';
import { TradeStore } from './TradeStore';

function makeStore(): TradeStore {
  const apiClient = {
    previewOrder: async () => {
      throw new Error('preview unavailable in test');
    },
  } as unknown as ApiClient;
  return new TradeStore(apiClient);
}

/** Minimal ChainStore double: arm() only reads getState(). Auto mode avoids
 *  the explicit strike/expiration guard. */
function autoModeChainStore(): ChainStore {
  return {
    getState: () => ({
      optionType: 'call' as const,
      isAutoMode: true,
      selectedExpiration: '2026-07-21',
      selectedStrike: null,
    }),
  } as unknown as ChainStore;
}

const placedOrder: OrderResult = {
  orderId: 'o1',
  status: 'submitted',
  contractSymbol: 'SPY 260721 C00500000',
  side: 'buy',
  quantity: 1,
  orderType: 'mid',
  timestamp: '2026-07-20T00:00:00Z',
};

describe('TradeStore.setQuantity', () => {
  it('clamps to the server-accepted range [1, 1000]', () => {
    const store = makeStore();
    store.setQuantity(0);
    expect(store.getState().quantity).toBe(1);
    store.setQuantity(5000);
    expect(store.getState().quantity).toBe(1000);
  });
});

describe('TradeStore.arm confirmation bypass', () => {
  it('submits directly without arming a ticket when bypass is on', async () => {
    const placeOrder = vi.fn(async () => placedOrder);
    const apiClient = {
      placeOrder,
      positions: async () => [],
      openOrders: async () => [],
    } as unknown as ApiClient;
    const store = new TradeStore(apiClient);

    store.arm('buy', 'SPY', autoModeChainStore(), true);

    expect(placeOrder).toHaveBeenCalledTimes(1);
    // Bypass never opens the confirm sheet.
    await vi.waitFor(() => expect(store.getState().armedTicket).toBeNull());
  });

  it('arms a ticket and does not submit when bypass is off', () => {
    const placeOrder = vi.fn(async () => placedOrder);
    const apiClient = {
      placeOrder,
      previewOrder: async () => {
        throw new Error('preview unavailable in test');
      },
    } as unknown as ApiClient;
    const store = new TradeStore(apiClient);

    store.arm('buy', 'SPY', autoModeChainStore(), false);

    expect(placeOrder).not.toHaveBeenCalled();
    expect(store.getState().armedTicket).not.toBeNull();
  });
});
