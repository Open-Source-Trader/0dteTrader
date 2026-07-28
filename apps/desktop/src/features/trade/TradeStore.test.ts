import { describe, expect, it, vi } from 'vitest';
import type { OptionContract, OrderResult, Position } from '@0dtetrader/shared-types';
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

const CONTRACT: OptionContract = {
  symbol: 'SPY260727C00505000',
  underlying: 'SPY',
  expiration: '2026-07-27',
  strike: 505,
  optionType: 'call',
  bid: 1.0,
  ask: 1.02,
  last: 1.01,
};

/** Minimal ChainStore stand-in: arm() only reads the selection state. */
function chainStub(overrides: Partial<Record<string, unknown>> = {}): ChainStore {
  return {
    selectedContract: CONTRACT,
    getState: () => ({
      optionType: 'call',
      isAutoMode: false,
      selectedExpiration: CONTRACT.expiration,
      selectedStrike: CONTRACT.strike,
      ...overrides,
    }),
  } as unknown as ChainStore;
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

function position(quantity: number): Position {
  return {
    symbol: CONTRACT.symbol,
    assetClass: 'option',
    quantity,
    avgPrice: 1,
    markPrice: 1.2,
    unrealizedPnl: 20,
    multiplier: 100,
  };
}

/** Seeds positions without a network round trip. */
function seedPositions(store: TradeStore, positions: Position[]): void {
  (store as unknown as { set(patch: { positions: Position[] }): void }).set({ positions });
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

describe('TradeStore.arm — selling into an open position', () => {
  it('closes the matching position instead of opening a short', () => {
    const store = makeStore();
    seedPositions(store, [position(3)]);
    store.setQuantity(3);

    store.arm('sell', 'SPY', chainStub());

    const ticket = store.getState().armedTicket;
    expect(ticket?.request.quantity).toBe(3);
    expect(ticket?.request.selection).toMatchObject({ mode: 'explicit', strike: 505 });
    expect(ticket?.summary).toContain('CLOSE 3');
  });

  it('caps the ticket quantity at the position, so it never flips into a short', () => {
    const store = makeStore();
    seedPositions(store, [position(2)]);
    store.setQuantity(10);

    store.arm('sell', 'SPY', chainStub());

    expect(store.getState().armedTicket?.request.quantity).toBe(2);
  });

  it('honors a smaller ticket quantity as a partial scale-out', () => {
    const store = makeStore();
    seedPositions(store, [position(10)]);
    store.setQuantity(3);

    store.arm('sell', 'SPY', chainStub());

    const ticket = store.getState().armedTicket;
    expect(ticket?.request.quantity).toBe(3);
    // The summary must say it's partial, not a full exit.
    expect(ticket?.summary).toContain('CLOSE 3 of 10');
  });

  it('leaves a buy alone', () => {
    const store = makeStore();
    seedPositions(store, [position(3)]);
    store.setQuantity(1);

    store.arm('buy', 'SPY', chainStub());

    expect(store.getState().armedTicket?.request.quantity).toBe(1);
    expect(store.getState().armedTicket?.summary).not.toContain('CLOSE');
  });

  it('opens a short when the position is on a different contract', () => {
    const store = makeStore();
    seedPositions(store, [{ ...position(3), symbol: 'SPY260727P00500000' }]);
    store.setQuantity(1);

    store.arm('sell', 'SPY', chainStub());

    expect(store.getState().armedTicket?.request.quantity).toBe(1);
    expect(store.getState().armedTicket?.summary).not.toContain('CLOSE');
  });

  it('does not treat an existing short as something to close', () => {
    const store = makeStore();
    seedPositions(store, [position(-3)]);
    store.setQuantity(1);

    store.arm('sell', 'SPY', chainStub());

    expect(store.getState().armedTicket?.request.quantity).toBe(1);
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

describe('TradeStore — refresh after placement does not stack on the WS push', () => {
  it('skips its own refresh when the order-update socket is connected', async () => {
    const placeOrder = vi.fn(async () => placedOrder);
    const positions = vi.fn(async () => []);
    const openOrders = vi.fn(async () => []);
    const apiClient = { placeOrder, positions, openOrders } as unknown as ApiClient;
    const store = new TradeStore(apiClient);
    store.isSocketConnected = () => true;

    store.arm('buy', 'SPY', autoModeChainStore(), true);
    await vi.waitFor(() => expect(store.getState().armedTicket).toBeNull());

    // The placement's own orderUpdate push is what refreshes when connected —
    // submitOrder must not also call positions/openOrders directly.
    expect(positions).not.toHaveBeenCalled();
    expect(openOrders).not.toHaveBeenCalled();
  });

  it('falls back to a direct refresh when the socket is disconnected', async () => {
    const placeOrder = vi.fn(async () => placedOrder);
    const positions = vi.fn(async () => []);
    const openOrders = vi.fn(async () => []);
    const apiClient = { placeOrder, positions, openOrders } as unknown as ApiClient;
    const store = new TradeStore(apiClient);
    store.isSocketConnected = () => false;

    store.arm('buy', 'SPY', autoModeChainStore(), true);
    await vi.waitFor(() => expect(store.getState().armedTicket).toBeNull());

    await vi.waitFor(() => {
      expect(positions).toHaveBeenCalledTimes(1);
      expect(openOrders).toHaveBeenCalledTimes(1);
    });
  });
});

describe('TradeStore.refreshTradingData — concurrent calls coalesce', () => {
  it('collapses overlapping refreshes into one in-flight run plus one queued', async () => {
    let resolvePositions!: () => void;
    const positions = vi.fn(
      () =>
        new Promise<Position[]>((resolve) => {
          resolvePositions = () => resolve([]);
        }),
    );
    const openOrders = vi.fn(async () => []);
    const apiClient = { positions, openOrders } as unknown as ApiClient;
    const store = new TradeStore(apiClient);

    // Simulates the submitted + terminal-status WS pushes both landing while
    // the first refresh they triggered is still in flight.
    const first = store.refreshTradingData();
    const second = store.refreshTradingData();
    const third = store.refreshTradingData();

    expect(positions).toHaveBeenCalledTimes(1);
    resolvePositions();
    await Promise.all([first, second, third]);

    // One run for the first call, one more to pick up what the queued
    // callers might have missed — never three.
    expect(positions).toHaveBeenCalledTimes(2);
  });
});

describe('TradeStore.cancelArmedOrder — the confirm popup dismissed', () => {
  it('cancels rather than confirms, and submits nothing', () => {
    const placeOrder = vi.fn(async () => placedOrder);
    const apiClient = {
      placeOrder,
      previewOrder: async () => {
        throw new Error('preview unavailable in test');
      },
    } as unknown as ApiClient;
    const store = new TradeStore(apiClient);
    store.arm('buy', 'SPY', autoModeChainStore(), false);
    expect(store.getState().armedTicket).not.toBeNull();

    // What the popup's scrim, its Escape key and its Cancel button all call.
    store.cancelArmedOrder();

    expect(store.getState().armedTicket).toBeNull();
    expect(placeOrder).not.toHaveBeenCalled();
  });
});

describe('TradeStore — order pricing', () => {
  it('rounds a custom limit to the contract tick', () => {
    const store = makeStore();
    store.setCustomLimitPrice(2.456);
    expect(store.getState().customLimitPrice).toBe(2.46);
    store.setCustomLimitPrice(null);
    expect(store.getState().customLimitPrice).toBeNull();
  });

  it('blocks arming Custom with no price, and nothing else', () => {
    const store = makeStore();
    for (const orderType of ['bid', 'mid', 'ask', 'market'] as const) {
      store.setOrderType(orderType);
      expect(store.canArm).toBe(true);
    }
    store.setOrderType('custom');
    expect(store.canArm).toBe(false);
    store.setCustomLimitPrice(2.45);
    expect(store.canArm).toBe(true);
  });

  it('drops the price and moves the highlight off Custom when the contract changes', () => {
    // A premium is only meaningful for the contract it was typed against, so a
    // contract change must not leave it armed on a different one.
    const store = makeStore();
    store.setOrderType('custom');
    store.setCustomLimitPrice(2.45);

    store.clearCustomLimitPrice();

    expect(store.getState().customLimitPrice).toBeNull();
    expect(store.getState().orderType).toBe('mid');
  });

  it('leaves another selection alone when clearing', () => {
    const store = makeStore();
    store.setOrderType('ask');
    store.clearCustomLimitPrice();
    expect(store.getState().orderType).toBe('ask');
  });

  it('sends limitPrice only for custom', () => {
    const store = makeStore();
    store.setOrderType('custom');
    store.setCustomLimitPrice(2.4);
    store.arm('buy', 'SPY', chainStub());
    expect(store.getState().armedTicket?.request.orderType).toBe('custom');
    expect(store.getState().armedTicket?.request.limitPrice).toBe(2.4);

    // The other four are priced from the server's own quote; a number
    // alongside them is one the server rejects outright.
    for (const orderType of ['bid', 'mid', 'ask', 'market'] as const) {
      store.setOrderType(orderType);
      store.arm('buy', 'SPY', chainStub());
      expect(store.getState().armedTicket?.request.orderType).toBe(orderType);
      expect(store.getState().armedTicket?.request.limitPrice).toBeUndefined();
    }
  });

  it('refuses to arm Custom with no price rather than sending none', () => {
    const store = makeStore();
    store.setOrderType('custom');

    store.arm('buy', 'SPY', chainStub());

    expect(store.getState().armedTicket).toBeNull();
    expect(store.getState().toast?.style).toBe('error');
  });
});
