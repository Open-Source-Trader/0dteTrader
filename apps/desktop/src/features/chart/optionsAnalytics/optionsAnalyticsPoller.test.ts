import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeOptionsAnalyticsSnapshot } from './optionsAnalyticsTestFixture';

interface VisibilityHarness {
  source: {
    isHidden(): boolean;
    subscribe(listener: () => void): () => void;
  };
  setHidden(hidden: boolean): void;
}

function makeVisibility(initiallyHidden = false): VisibilityHarness {
  let hidden = initiallyHidden;
  const listeners = new Set<() => void>();
  return {
    source: {
      isHidden: () => hidden,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    setHidden(next) {
      hidden = next;
      for (const listener of listeners) listener();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function loadPollerModule() {
  return import('./optionsAnalyticsPoller').catch(() => null);
}

describe('OptionsAnalyticsPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T14:30:10.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for an in-flight request before scheduling the next poll', async () => {
    const module = await loadPollerModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const first = deferred<ReturnType<typeof makeOptionsAnalyticsSnapshot>>();
    const fetchSnapshot = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(
        makeOptionsAnalyticsSnapshot({
          scope: {
            ...makeOptionsAnalyticsSnapshot().scope,
            observedAt: '2026-07-19T14:31:00.000Z',
          },
        }),
      );
    const visibility = makeVisibility();
    const poller = new module.OptionsAnalyticsPoller(fetchSnapshot, visibility.source);

    poller.start({ symbol: 'SPY', expiration: '2026-07-19', refreshSeconds: 45 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    first.resolve(makeOptionsAnalyticsSnapshot());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it('aborts the old generation and discards its late mismatched response', async () => {
    const module = await loadPollerModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const oldRequest = deferred<ReturnType<typeof makeOptionsAnalyticsSnapshot>>();
    const newRequest = deferred<ReturnType<typeof makeOptionsAnalyticsSnapshot>>();
    const signals: AbortSignal[] = [];
    const fetchSnapshot = vi.fn((_symbol: string, _expiration: string, signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? oldRequest.promise : newRequest.promise;
    });
    const visibility = makeVisibility();
    const poller = new module.OptionsAnalyticsPoller(fetchSnapshot, visibility.source);

    poller.start({ symbol: 'SPY', expiration: '2026-07-19', refreshSeconds: 45 });
    poller.start({ symbol: 'QQQ', expiration: '2026-07-20', refreshSeconds: 45 });
    expect(signals[0]?.aborted).toBe(true);

    oldRequest.resolve(makeOptionsAnalyticsSnapshot());
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getState().snapshot).toBeNull();

    newRequest.resolve(
      makeOptionsAnalyticsSnapshot({
        scope: {
          ...makeOptionsAnalyticsSnapshot().scope,
          symbol: 'QQQ',
          rootSymbol: 'QQQ',
          expiration: '2026-07-20',
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getState().snapshot?.scope.symbol).toBe('QQQ');
    poller.stop();
  });

  it('pauses and aborts while hidden, then immediately refetches when visible', async () => {
    const module = await loadPollerModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const visibility = makeVisibility(true);
    const pending = deferred<ReturnType<typeof makeOptionsAnalyticsSnapshot>>();
    const fetchSnapshot = vi.fn().mockReturnValue(pending.promise);
    const poller = new module.OptionsAnalyticsPoller(fetchSnapshot, visibility.source);

    poller.start({ symbol: 'SPY', expiration: '2026-07-19', refreshSeconds: 45 });
    expect(fetchSnapshot).not.toHaveBeenCalled();

    visibility.setHidden(false);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    const signal = fetchSnapshot.mock.calls[0]?.[2] as AbortSignal;
    visibility.setHidden(true);
    expect(signal.aborted).toBe(true);

    visibility.setHidden(false);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it('silently ignores abort errors', async () => {
    const module = await loadPollerModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const visibility = makeVisibility();
    const fetchSnapshot = vi
      .fn()
      .mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));
    const poller = new module.OptionsAnalyticsPoller(fetchSnapshot, visibility.source);

    poller.start({ symbol: 'SPY', expiration: '2026-07-19', refreshSeconds: 45 });
    await vi.advanceTimersByTimeAsync(0);

    expect(poller.getState().errorMessage).toBeNull();
    expect(poller.getState().isLoading).toBe(false);
    poller.stop();
  });

  it('retains only an exact, unexpired snapshot inside the bounded refresh window', async () => {
    const module = await loadPollerModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const snapshot = makeOptionsAnalyticsSnapshot({
      scope: {
        ...makeOptionsAnalyticsSnapshot().scope,
        observedAt: '2026-07-19T14:28:41.000Z',
      },
    });

    expect(
      module.isRetainableOptionsAnalyticsSnapshot(
        snapshot,
        { symbol: 'SPY', expiration: '2026-07-19', refreshSeconds: 45 },
        Date.now(),
      ),
    ).toBe(true);
    expect(
      module.isRetainableOptionsAnalyticsSnapshot(
        snapshot,
        { symbol: 'QQQ', expiration: '2026-07-19', refreshSeconds: 45 },
        Date.now(),
      ),
    ).toBe(false);
    expect(
      module.isRetainableOptionsAnalyticsSnapshot(
        snapshot,
        { symbol: 'SPY', expiration: '2026-07-19', refreshSeconds: 45 },
        Date.parse('2026-07-19T14:30:12.000Z'),
      ),
    ).toBe(false);
  });
});
