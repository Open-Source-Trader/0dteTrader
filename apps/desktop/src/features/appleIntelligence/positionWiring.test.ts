import { describe, expect, it } from 'vitest';
import type { Position } from '@0dtetrader/shared-types';
import { connectPositionAnalysis, type PositionWiringDeps } from './positionWiring';
import type { AnalysisSnapshot, TriggerPriority } from './types';

function position(overrides: Partial<Position> = {}): Position {
  return {
    symbol: 'SPY260731C00500000',
    assetClass: 'OPTION',
    quantity: 2,
    avgPrice: 1.25,
    markPrice: 1.25,
    unrealizedPnl: 0,
    multiplier: 100,
    ...overrides,
  } as Position;
}

function makeHarness(
  availability: 'ready' | 'unavailable' = 'ready',
  initialPositions: Position[] = [],
) {
  const listeners = new Set<() => void>();
  const submitted: { snapshot: AnalysisSnapshot; priority: TriggerPriority | undefined }[] = [];
  let positions = initialPositions;

  const deps: PositionWiringDeps = {
    tradeStore: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getState: () =>
        ({ positions }) as unknown as ReturnType<PositionWiringDeps['tradeStore']['getState']>,
    },
    chartStore: {
      getState: () =>
        ({
          symbol: 'SPY',
          interval: '1m',
          candles: [],
          quote: null,
          isStale: false,
        }) as unknown as ReturnType<PositionWiringDeps['chartStore']['getState']>,
    },
    analysisStore: {
      getState: () =>
        ({ availability: { state: availability } }) as unknown as ReturnType<
          PositionWiringDeps['analysisStore']['getState']
        >,
      analyze: async (snapshot: AnalysisSnapshot, priority?: TriggerPriority) => {
        submitted.push({ snapshot, priority });
      },
    },
  };

  const setPositions = (next: Position[]) => {
    positions = next;
    listeners.forEach((listener) => listener());
  };
  /** Fires the subscription without changing the positions array reference
   * — simulates a toast/unrelated TradeStore set() that notifies every
   * subscriber but never touches positions. */
  const notify = () => {
    listeners.forEach((listener) => listener());
  };
  return { deps, setPositions, notify, submitted };
}

describe('connectPositionAnalysis', () => {
  it('submits a position-critical analysis when a position opens', () => {
    const { deps, setPositions, submitted } = makeHarness('ready');
    connectPositionAnalysis(deps);

    setPositions([position()]);

    expect(submitted).toHaveLength(1);
    expect(submitted[0].priority).toBe('position-critical');
    expect(submitted[0].snapshot.trigger.kind).toBe('position-change');
    expect(submitted[0].snapshot.position).toMatchObject({ quantity: 2, avgPrice: 1.25 });
  });

  it('builds a close snapshot without position data and declares the omission', () => {
    const { deps, setPositions, submitted } = makeHarness('ready', [position()]);
    connectPositionAnalysis(deps);

    setPositions([]);

    expect(submitted).toHaveLength(1);
    expect(submitted[0].snapshot.position).toBeUndefined();
    expect(submitted[0].snapshot.omissions).toContainEqual(
      expect.objectContaining({ code: 'position-data-missing', material: true }),
    );
  });

  it('does not submit while the model is not ready, and never fires retroactively', () => {
    const { deps, setPositions, submitted } = makeHarness('unavailable');
    connectPositionAnalysis(deps);

    setPositions([position()]);
    expect(submitted).toEqual([]);

    // The watch state advanced during unavailability: a no-op notify later
    // must not replay the missed open.
    setPositions([position()]);
    expect(submitted).toEqual([]);
  });

  it('ignores notifies with no position change (e.g. quantity picker, toasts)', () => {
    const { deps, setPositions, submitted } = makeHarness('ready', [position()]);
    connectPositionAnalysis(deps);

    setPositions([position()]);

    expect(submitted).toEqual([]);
  });

  it('is a no-op for a notify whose positions array reference is unchanged (toast-only updates)', () => {
    // TradeStore.subscribe() is whole-store: a toast queue/dismiss set()
    // notifies every subscriber without touching `positions` at all — the
    // array reference stays identical, unlike the "quantity picker" case
    // above (a genuinely new array with the same content). Both must
    // produce zero submissions, but this is the cheap-skip path.
    const { deps, submitted, notify } = makeHarness('ready', [position()]);
    connectPositionAnalysis(deps);

    notify();

    expect(submitted).toEqual([]);
  });

  it('stops firing after disconnect', () => {
    const { deps, setPositions, submitted } = makeHarness('ready');
    const disconnect = connectPositionAnalysis(deps);
    disconnect();

    setPositions([position()]);

    expect(submitted).toEqual([]);
  });
});
