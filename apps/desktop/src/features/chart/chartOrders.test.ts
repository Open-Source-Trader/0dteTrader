import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChartOrder } from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { ChartOrdersStore, isWorking, kindLabel, orderTypeLabel } from './chartOrders';

function order(overrides: Partial<ChartOrder> = {}): ChartOrder {
  return {
    id: 'co-1',
    underlying: 'SPY',
    triggerPrice: 98,
    armPrice: 100,
    side: 'buy',
    quantity: 1,
    orderType: 'mid',
    kind: 'limit',
    optionType: 'call',
    expiration: '2026-07-27',
    strike: 101,
    contractSymbol: 'SPY260727C00101000',
    ocoGroupId: null,
    status: 'working',
    createdAt: '2026-07-24T15:00:00.000Z',
    expiresAt: '2026-07-27T20:00:00.000Z',
    triggeredAt: null,
    brokerOrderId: null,
    lastError: null,
    ...overrides,
  };
}

describe('ChartOrdersStore', () => {
  let api: {
    chartOrders: ReturnType<typeof vi.fn>;
    createChartOrder: ReturnType<typeof vi.fn>;
    updateChartOrder: ReturnType<typeof vi.fn>;
    cancelChartOrder: ReturnType<typeof vi.fn>;
    triggerChartOrder: ReturnType<typeof vi.fn>;
  };
  let store: ChartOrdersStore;

  beforeEach(() => {
    api = {
      chartOrders: vi.fn(async () => [] as ChartOrder[]),
      createChartOrder: vi.fn(async () => order()),
      updateChartOrder: vi.fn(async (id: string, patch: Record<string, unknown>) => ({
        ...order({ id }),
        ...patch,
      })),
      cancelChartOrder: vi.fn(async () => undefined),
      triggerChartOrder: vi.fn(async (id: string) =>
        order({ id, status: 'triggered', brokerOrderId: 'B-1' }),
      ),
    };
    store = new ChartOrdersStore(api as unknown as ApiClient);
  });

  /** Seeds the store as if the server had returned these lines. */
  async function seed(...orders: ChartOrder[]): Promise<void> {
    api.chartOrders.mockResolvedValueOnce(orders);
    await store.load();
  }

  describe('triggering', () => {
    it('fires a line the tick crossed from its armed side', async () => {
      await seed(order({ triggerPrice: 98, armPrice: 100 }));

      store.applyQuote('SPY', 101); // seeds the previous price
      store.applyQuote('SPY', 97);
      await Promise.resolve();

      expect(api.triggerChartOrder).toHaveBeenCalledWith('co-1');
    });

    it('does not fire on the first tick when price is merely near the level', async () => {
      await seed(order({ triggerPrice: 98, armPrice: 100 }));

      store.applyQuote('SPY', 98.5);

      expect(api.triggerChartOrder).not.toHaveBeenCalled();
    });

    it('fires from the arm price on the very first tick, catching a gap', async () => {
      // The client has seen no prior tick — a level the price already blew
      // through must still fire rather than waiting for a round trip back.
      await seed(order({ triggerPrice: 98, armPrice: 100 }));

      store.applyQuote('SPY', 90);
      await Promise.resolve();

      expect(api.triggerChartOrder).toHaveBeenCalledTimes(1);
    });

    it('does not fire a line armed below a level price has not reached', async () => {
      await seed(order({ triggerPrice: 105, armPrice: 100 }));

      store.applyQuote('SPY', 90);
      store.applyQuote('SPY', 104);

      expect(api.triggerChartOrder).not.toHaveBeenCalled();
    });

    it('fires an upward trigger once price reaches it', async () => {
      await seed(order({ triggerPrice: 105, armPrice: 100 }));

      store.applyQuote('SPY', 106);
      await Promise.resolve();

      expect(api.triggerChartOrder).toHaveBeenCalledTimes(1);
    });

    it('fires once even when several ticks straddle the level', async () => {
      await seed(order({ triggerPrice: 98, armPrice: 100 }));

      store.applyQuote('SPY', 97);
      store.applyQuote('SPY', 96);
      store.applyQuote('SPY', 95);
      await Promise.resolve();

      expect(api.triggerChartOrder).toHaveBeenCalledTimes(1);
    });

    it('ignores ticks for other underlyings', async () => {
      await seed(order({ underlying: 'SPY', triggerPrice: 98, armPrice: 100 }));

      store.applyQuote('QQQ', 50);

      expect(api.triggerChartOrder).not.toHaveBeenCalled();
    });

    it('never fires a line that is no longer working', async () => {
      await seed(order({ status: 'triggered', triggerPrice: 98, armPrice: 100 }));

      store.applyQuote('SPY', 90);

      expect(api.triggerChartOrder).not.toHaveBeenCalled();
    });

    it('ignores junk prices', async () => {
      await seed(order({ triggerPrice: 98, armPrice: 100 }));

      store.applyQuote('SPY', Number.NaN);
      store.applyQuote('SPY', 0);

      expect(api.triggerChartOrder).not.toHaveBeenCalled();
    });
  });

  describe('execution type', () => {
    it('flips MID to MKT optimistically and keeps the server value', async () => {
      await seed(order({ orderType: 'mid' }));

      await store.toggleOrderType('co-1');

      expect(api.updateChartOrder).toHaveBeenCalledWith('co-1', { orderType: 'market' });
      expect(store.byId('co-1')?.orderType).toBe('market');
    });

    it('reverts the pill when the server rejects the flip', async () => {
      await seed(order({ orderType: 'mid' }));
      api.updateChartOrder.mockRejectedValueOnce(new Error('already fired'));

      await store.toggleOrderType('co-1');

      expect(store.byId('co-1')?.orderType).toBe('mid');
      expect(store.getState().error).toContain('already fired');
    });

    it('will not flip a line that already fired', async () => {
      await seed(order({ status: 'triggered' }));

      await store.toggleOrderType('co-1');

      expect(api.updateChartOrder).not.toHaveBeenCalled();
    });
  });

  describe('visibility', () => {
    it('draws only lines on the current chart', async () => {
      await seed(order({ id: 'a', underlying: 'SPY' }), order({ id: 'b', underlying: 'QQQ' }));
      store.setSymbol('SPY');

      expect(store.visibleOrders.map((o) => o.id)).toEqual(['a']);
    });

    it('keeps a failed line on the chart so the reason is visible', async () => {
      await seed(order({ status: 'failed', lastError: 'insufficient buying power' }));
      store.setSymbol('SPY');

      expect(store.visibleOrders).toHaveLength(1);
    });

    it('drops a cancelled line', async () => {
      await seed(order({ status: 'cancelled' }));
      store.setSymbol('SPY');

      expect(store.visibleOrders).toHaveLength(0);
    });
  });

  describe('dismissing terminal lines', () => {
    it('clears a failed line locally, with no doomed cancel request', async () => {
      // The server refuses to cancel a non-working line, so calling out would
      // only produce an error and leave the line stuck on the chart.
      await seed(order({ status: 'failed', lastError: 'insufficient buying power' }));

      await store.cancel('co-1');

      expect(api.cancelChartOrder).not.toHaveBeenCalled();
      expect(store.byId('co-1')).toBeUndefined();
      expect(store.getState().error).toBeNull();
    });

    it('clears a triggered line the same way', async () => {
      await seed(order({ status: 'triggered' }));

      await store.cancel('co-1');

      expect(api.cancelChartOrder).not.toHaveBeenCalled();
      expect(store.byId('co-1')).toBeUndefined();
    });

    it('still cancels a working line server-side', async () => {
      await seed(order({ status: 'working' }));

      await store.cancel('co-1');

      expect(api.cancelChartOrder).toHaveBeenCalledWith('co-1');
      expect(store.byId('co-1')).toBeUndefined();
    });

    /**
     * The ✕ routes on this predicate (OrderLineLayer): a working line raises
     * `onCancelOrder` so TradeScreen can confirm, a terminal one is dismissed
     * outright. Pinned here because it must stay identical to the iOS side —
     * confirming a triggered line with "nothing was sent to the broker" would
     * describe a live order as though it never left.
     */
    it('routes only working lines to the confirmation', () => {
      expect(isWorking(order({ status: 'working' }))).toBe(true);
      for (const status of ['triggered', 'failed', 'filled', 'cancelled', 'expired'] as const) {
        expect(isWorking(order({ status }))).toBe(false);
      }
    });
  });

  describe('server updates', () => {
    it('applies a watcher push', async () => {
      await seed(order({ status: 'working' }));

      store.applyServerUpdate(order({ status: 'triggered', brokerOrderId: 'B-9' }));

      expect(store.byId('co-1')?.brokerOrderId).toBe('B-9');
    });

    it('removes a line the watcher retired', async () => {
      await seed(order());

      store.applyServerUpdate(order({ status: 'cancelled' }));

      expect(store.byId('co-1')).toBeUndefined();
    });
  });

  describe('resync (load merges rather than replaces)', () => {
    /** Deferred response so a push can be injected mid-flight. */
    function deferredLoad(orders: ChartOrder[]) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      api.chartOrders.mockImplementationOnce(async () => {
        await gate;
        return orders;
      });
      return release;
    }

    /**
     * The snapshot is a read from before it arrived, so a push that overtook it
     * is newer. Replacing wholesale would put a fired line back on the chart as
     * live and draggable.
     */
    it('does not let a stale snapshot resurrect a line the watcher just fired', async () => {
      await seed(order({ status: 'working' }));
      const release = deferredLoad([order({ status: 'working' })]);

      const loading = store.load();
      store.applyServerUpdate(order({ status: 'triggered', brokerOrderId: 'B-1' }));
      release();
      await loading;

      expect(store.byId('co-1')?.status).toBe('triggered');
      expect(store.byId('co-1')?.brokerOrderId).toBe('B-1');
    });

    it('keeps a line the watcher retired mid-load gone', async () => {
      await seed(order({ status: 'working' }));
      const release = deferredLoad([order({ status: 'working' })]);

      const loading = store.load();
      store.applyServerUpdate(order({ status: 'cancelled' }));
      release();
      await loading;

      expect(store.byId('co-1')).toBeUndefined();
    });

    it('still adopts snapshot rows the socket said nothing about', async () => {
      await seed(order({ id: 'a', status: 'working' }));
      const release = deferredLoad([order({ id: 'a' }), order({ id: 'b', triggerPrice: 97 })]);

      const loading = store.load();
      store.applyServerUpdate(order({ id: 'a', status: 'triggered' }));
      release();
      await loading;

      expect(store.byId('a')?.status).toBe('triggered');
      expect(store.byId('b')).toBeDefined();
    });

    it('discards a superseded snapshot when two loads overlap', async () => {
      const releaseFirst = deferredLoad([order({ id: 'stale' })]);
      const first = store.load();
      api.chartOrders.mockResolvedValueOnce([order({ id: 'fresh' })]);
      await store.load();
      releaseFirst();
      await first;

      expect(store.byId('fresh')).toBeDefined();
      expect(store.byId('stale')).toBeUndefined();
    });
  });

  describe('reset', () => {
    it('clears everything when the trading mode changes', async () => {
      await seed(order());

      store.reset();

      expect(store.getState().orders).toEqual([]);
    });

    it('forgets price history, so lines re-arm from their own arm price', async () => {
      await seed(order({ triggerPrice: 98, armPrice: 100 }));
      store.applyQuote('SPY', 99);
      store.reset();
      await seed(order({ triggerPrice: 98, armPrice: 100 }));

      store.applyQuote('SPY', 90);
      await Promise.resolve();

      expect(api.triggerChartOrder).toHaveBeenCalledTimes(1);
    });
  });
});

describe('labels', () => {
  it('names each kind', () => {
    expect(kindLabel('limit')).toBe('LMT');
    expect(kindLabel('target')).toBe('TP');
    expect(kindLabel('stop')).toBe('STP');
  });

  it('abbreviates market so the pill keeps its width when toggled', () => {
    expect(orderTypeLabel('mid')).toBe('MID');
    expect(orderTypeLabel('market')).toBe('MKT');
    expect(orderTypeLabel('mid').length).toBe(orderTypeLabel('market').length);
  });
});
