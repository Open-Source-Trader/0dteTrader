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

/**
 * Wires `optionContractResolver` the way the trade screen does in
 * production — close-detection resolves held positions through it rather
 * than trusting `chainStore.selectedContract`, which can be a different,
 * AUTO-drifted strike than what is actually held.
 */
function withResolver(store: TradeStore, contracts: OptionContract[]): TradeStore {
  store.optionContractResolver = (symbol) => contracts.find((c) => c.symbol === symbol);
  return store;
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
    const store = withResolver(makeStore(), [CONTRACT]);
    seedPositions(store, [position(3)]);
    store.setQuantity(3);

    store.arm('sell', 'SPY', chainStub());

    const ticket = store.getState().armedTicket;
    expect(ticket?.request.quantity).toBe(3);
    expect(ticket?.request.selection).toMatchObject({ mode: 'explicit', strike: 505 });
    expect(ticket?.summary).toContain('CLOSE 3');
  });

  it('caps the ticket quantity at the position, so it never flips into a short', () => {
    const store = withResolver(makeStore(), [CONTRACT]);
    seedPositions(store, [position(2)]);
    store.setQuantity(10);

    store.arm('sell', 'SPY', chainStub());

    expect(store.getState().armedTicket?.request.quantity).toBe(2);
  });

  it('honors a smaller ticket quantity as a partial scale-out', () => {
    const store = withResolver(makeStore(), [CONTRACT]);
    seedPositions(store, [position(10)]);
    store.setQuantity(3);

    store.arm('sell', 'SPY', chainStub());

    const ticket = store.getState().armedTicket;
    expect(ticket?.request.quantity).toBe(3);
    // The summary must say it's partial, not a full exit.
    expect(ticket?.summary).toContain('CLOSE 3 of 10');
  });

  it('leaves a buy alone', () => {
    const store = withResolver(makeStore(), [CONTRACT]);
    seedPositions(store, [position(3)]);
    store.setQuantity(1);

    store.arm('buy', 'SPY', chainStub());

    expect(store.getState().armedTicket?.request.quantity).toBe(1);
    expect(store.getState().armedTicket?.summary).not.toContain('CLOSE');
  });

  it('opens a short when the held position is unresolvable (different/unknown contract)', () => {
    const store = withResolver(makeStore(), [CONTRACT]);
    seedPositions(store, [{ ...position(3), symbol: 'SPY260727P00500000' }]);
    store.setQuantity(1);

    store.arm('sell', 'SPY', chainStub());

    expect(store.getState().armedTicket?.request.quantity).toBe(1);
    expect(store.getState().armedTicket?.summary).not.toContain('CLOSE');
  });

  it('does not treat an existing short as something to close', () => {
    const store = withResolver(makeStore(), [CONTRACT]);
    seedPositions(store, [position(-3)]);
    store.setQuantity(1);

    store.arm('sell', 'SPY', chainStub());

    expect(store.getState().armedTicket?.request.quantity).toBe(1);
  });

  // Reproduces the reported incident: AUTO mode's live strike has drifted off
  // the strike actually held (e.g. after a sharp move in the underlying), so
  // the two contracts no longer share a symbol. Matching on underlying +
  // expiration + right (ignoring strike) still finds the held put and closes
  // it at ITS strike — not the drifted one the panel currently displays —
  // instead of silently opening a new naked short.
  it('closes the held position even when the AUTO strike has drifted', () => {
    const heldPut: OptionContract = {
      symbol: 'SPY260727P00500000',
      underlying: 'SPY',
      expiration: CONTRACT.expiration,
      strike: 500,
      optionType: 'put',
      bid: 1.0,
      ask: 1.02,
      last: 1.01,
    };
    const driftedPut: OptionContract = {
      symbol: 'SPY260727P00490000',
      underlying: 'SPY',
      expiration: CONTRACT.expiration,
      strike: 490,
      optionType: 'put',
      bid: 0.5,
      ask: 0.52,
      last: 0.51,
    };
    const store = withResolver(makeStore(), [heldPut, driftedPut]);
    seedPositions(store, [{ ...position(2), symbol: heldPut.symbol }]);
    store.setQuantity(2);
    // AUTO mode currently selects the drifted put, not the held strike.
    const chain = {
      selectedContract: driftedPut,
      getState: () => ({
        optionType: 'put' as const,
        isAutoMode: true,
        selectedExpiration: CONTRACT.expiration,
        selectedStrike: null,
      }),
    } as unknown as ChainStore;

    store.arm('sell', 'SPY', chain);

    const ticket = store.getState().armedTicket;
    expect(ticket?.request.selection).toMatchObject({ strike: 500 });
    expect(ticket?.request.quantity).toBe(2);
    expect(ticket?.summary).toContain('CLOSE 2');
  });

  // Two held legs at different strikes, same underlying/expiration/right
  // (e.g. a put spread): the higher-P/L leg closes first, and the summary
  // says "of <total>" so the user sees the other leg is still open.
  it('closes the highest-P/L leg first when multiple legs match', () => {
    const legA: OptionContract = {
      symbol: 'SPY260727P00500000',
      underlying: 'SPY',
      expiration: CONTRACT.expiration,
      strike: 500,
      optionType: 'put',
      bid: 1.0,
      ask: 1.02,
      last: 1.01,
    };
    const legB: OptionContract = {
      symbol: 'SPY260727P00495000',
      underlying: 'SPY',
      expiration: CONTRACT.expiration,
      strike: 495,
      optionType: 'put',
      bid: 0.5,
      ask: 0.52,
      last: 0.51,
    };
    const store = withResolver(makeStore(), [legA, legB]);
    seedPositions(store, [
      { ...position(2), symbol: legA.symbol, unrealizedPnl: 5 },
      { ...position(3), symbol: legB.symbol, unrealizedPnl: 50 },
    ]);
    store.setQuantity(10);
    const chain = {
      selectedContract: legA,
      getState: () => ({
        optionType: 'put' as const,
        isAutoMode: false,
        selectedExpiration: CONTRACT.expiration,
        selectedStrike: 500,
      }),
    } as unknown as ChainStore;

    store.arm('sell', 'SPY', chain);

    const ticket = store.getState().armedTicket;
    expect(ticket?.request.selection).toMatchObject({ strike: 495 });
    expect(ticket?.request.quantity).toBe(3);
    expect(ticket?.summary).toContain('CLOSE 3 of 5');
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

describe('TradeStore position-management exits', () => {
  it('prevents duplicate close submissions while one is pending', async () => {
    let resolveOrder!: () => void;
    const placeOrder = vi.fn(
      () =>
        new Promise<OrderResult>((resolve) => {
          resolveOrder = () => resolve({ ...placedOrder, side: 'sell', quantity: 2 });
        }),
    );
    const apiClient = {
      placeOrder,
      positions: async () => [],
      openOrders: async () => [],
    } as unknown as ApiClient;
    const store = withResolver(new TradeStore(apiClient), [CONTRACT]);
    store.isSocketConnected = () => true;
    const held = position(2);

    const first = store.flatten(held);
    const second = store.flatten(held);

    expect(placeOrder).toHaveBeenCalledTimes(1);
    resolveOrder();
    await Promise.all([first, second]);
  });

  it('trims half of the correct position quantity', async () => {
    const placeOrder = vi.fn(async () => ({ ...placedOrder, side: 'sell', quantity: 2 }));
    const apiClient = {
      placeOrder,
      positions: async () => [],
      openOrders: async () => [],
    } as unknown as ApiClient;
    const store = withResolver(new TradeStore(apiClient), [CONTRACT]);
    store.isSocketConnected = () => true;

    await store.trimHalf(position(5));

    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: 'sell',
        quantity: 2,
        orderType: 'market',
        selection: expect.objectContaining({ strike: CONTRACT.strike }),
      }),
      expect.any(String),
    );
  });
});

describe('TradeStore.refreshTradingData — positions and open orders run in parallel', () => {
  it('starts the openOrders request without waiting for positions to resolve', async () => {
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

    const refresh = store.refreshTradingData();
    // positions() is still pending, but openOrders() must already have fired —
    // a serialized refresh would not call it until positions() resolved.
    expect(openOrders).toHaveBeenCalledTimes(1);

    resolvePositions();
    await refresh;
  });

  it('surfaces the positions failure even when open orders succeeds', async () => {
    const positions = vi.fn(async () => {
      throw new Error('positions unavailable');
    });
    const openOrders = vi.fn(async () => []);
    const apiClient = { positions, openOrders } as unknown as ApiClient;
    const store = new TradeStore(apiClient);

    await store.refreshTradingData();

    expect(store.getState().toast?.message).toBe('positions unavailable');
    expect(store.getState().openOrders).toEqual([]);
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

describe('TradeStore.applyContractQuote', () => {
  it('updates the matching position mark and P/L', () => {
    const store = makeStore();
    seedPositions(store, [position(2)]);
    store.applyContractQuote({
      symbol: CONTRACT.symbol,
      last: 1.5,
      bid: 1.48,
      ask: 1.52,
    } as unknown as Parameters<TradeStore['applyContractQuote']>[0]);
    const [updated] = store.getState().positions;
    expect(updated.markPrice).toBe(1.5);
    expect(updated.unrealizedPnl).toBe(Math.round((1.5 - 1) * 2 * 100 * 100) / 100);
  });

  it('leaves positions untouched when no symbol matches', () => {
    const store = makeStore();
    const seeded = [position(2)];
    seedPositions(store, seeded);
    store.applyContractQuote({
      symbol: 'QQQ260101C00500000',
      last: 5,
      bid: 4.9,
      ask: 5.1,
    } as unknown as Parameters<TradeStore['applyContractQuote']>[0]);
    expect(store.getState().positions).toBe(seeded);
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
