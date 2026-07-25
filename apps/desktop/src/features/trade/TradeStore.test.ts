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
