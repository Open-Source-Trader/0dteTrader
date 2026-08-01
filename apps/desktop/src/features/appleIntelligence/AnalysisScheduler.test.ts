import { describe, expect, it } from 'vitest';
import { AnalysisScheduler, shouldPreempt, type QueuedWork } from './AnalysisScheduler';
import type { AnalysisSnapshot, TriggerPriority } from './types';

function snapshot(symbol = 'SPY'): AnalysisSnapshot {
  return {
    snapshotSchemaVersion: 1,
    identity: {
      snapshotId: `${symbol}-1`,
      capturedAt: '2026-07-31T00:00:00.000Z',
      symbol,
      timeframe: '5m',
      snapshotSequence: 1,
      positionVersion: 0,
    },
    trigger: { kind: 'candle-close', priority: 'candle-close', reason: 'candle closed' },
    market: {},
    candles: {},
    indicators: {},
    levels: [],
    quality: {
      capturedAt: '2026-07-31T00:00:00.000Z',
      candlesFreshAsOf: '2026-07-31T00:00:00.000Z',
      isChainStale: false,
    },
    omissions: [],
  };
}

function work(overrides: Partial<QueuedWork> = {}): QueuedWork {
  return {
    snapshot: snapshot(),
    priority: 'background',
    dedupeKey: Math.random().toString(36),
    ...overrides,
  };
}

describe('AnalysisScheduler.submit', () => {
  it('accepts work into an empty queue', () => {
    const scheduler = new AnalysisScheduler();
    const result = scheduler.submit(work({ dedupeKey: 'a' }));
    expect(result).not.toBeNull();
    expect(scheduler.size).toBe(1);
  });

  it('drops an exact duplicate (same dedupeKey)', () => {
    const scheduler = new AnalysisScheduler();
    scheduler.submit(work({ dedupeKey: 'same' }));
    const result = scheduler.submit(work({ dedupeKey: 'same' }));
    expect(result).toBeNull();
    expect(scheduler.size).toBe(1);
  });

  it('dequeues highest priority first regardless of submission order', () => {
    const scheduler = new AnalysisScheduler();
    scheduler.submit(work({ dedupeKey: 'bg', priority: 'background' }));
    scheduler.submit(work({ dedupeKey: 'candle', priority: 'candle-close' }));
    scheduler.submit(work({ dedupeKey: 'crit', priority: 'position-critical' }));
    scheduler.submit(work({ dedupeKey: 'manual', priority: 'manual' }));

    expect(scheduler.dequeueNext()?.dedupeKey).toBe('crit');
    expect(scheduler.dequeueNext()?.dedupeKey).toBe('manual');
    expect(scheduler.dequeueNext()?.dedupeKey).toBe('candle');
    expect(scheduler.dequeueNext()?.dedupeKey).toBe('bg');
  });

  it('replaces an older queued candle-close in the same symbol+timeframe slot', () => {
    const scheduler = new AnalysisScheduler();
    scheduler.submit(
      work({ dedupeKey: 'close-1000', priority: 'candle-close', replaceKey: 'SPY:5m' }),
    );
    scheduler.submit(
      work({ dedupeKey: 'close-1300', priority: 'candle-close', replaceKey: 'SPY:5m' }),
    );

    expect(scheduler.size).toBe(1);
    expect(scheduler.dequeueNext()?.dedupeKey).toBe('close-1300');
  });

  it('does not replace across different symbol+timeframe slots', () => {
    const scheduler = new AnalysisScheduler();
    scheduler.submit(
      work({ dedupeKey: 'spy-close', priority: 'candle-close', replaceKey: 'SPY:5m' }),
    );
    scheduler.submit(
      work({ dedupeKey: 'qqq-close', priority: 'candle-close', replaceKey: 'QQQ:5m' }),
    );
    expect(scheduler.size).toBe(2);
  });

  it('bounds the queue and drops new background work when full of equal-or-higher priority items', () => {
    const scheduler = new AnalysisScheduler(2);
    scheduler.submit(work({ dedupeKey: 'a', priority: 'manual' }));
    scheduler.submit(work({ dedupeKey: 'b', priority: 'manual' }));
    const result = scheduler.submit(work({ dedupeKey: 'c', priority: 'background' }));
    expect(result).toBeNull();
    expect(scheduler.size).toBe(2);
  });

  it('evicts a lower-priority item to make room for higher-priority work when full', () => {
    const scheduler = new AnalysisScheduler(2);
    scheduler.submit(work({ dedupeKey: 'bg1', priority: 'background' }));
    scheduler.submit(work({ dedupeKey: 'bg2', priority: 'background' }));
    const result = scheduler.submit(work({ dedupeKey: 'crit', priority: 'position-critical' }));
    expect(result).not.toBeNull();
    expect(scheduler.size).toBe(2);
    expect(scheduler.peekAll().some((w) => w.dedupeKey === 'crit')).toBe(true);
  });
});

describe('AnalysisScheduler.dropBackgroundWork', () => {
  it('removes only background-priority queued items', () => {
    const scheduler = new AnalysisScheduler();
    scheduler.submit(work({ dedupeKey: 'bg', priority: 'background' }));
    scheduler.submit(work({ dedupeKey: 'manual', priority: 'manual' }));
    scheduler.dropBackgroundWork();
    expect(scheduler.size).toBe(1);
    expect(scheduler.peekAll()[0].dedupeKey).toBe('manual');
  });
});

describe('shouldPreempt', () => {
  const cases: Array<[TriggerPriority, TriggerPriority, boolean]> = [
    ['candle-close', 'position-critical', true],
    ['background', 'position-critical', true],
    ['manual', 'position-critical', false],
    ['position-critical', 'position-critical', false],
    ['background', 'manual', true],
    ['candle-close', 'manual', false],
    ['position-critical', 'manual', false],
    ['background', 'candle-close', false],
    ['background', 'background', false],
  ];

  it.each(cases)('active=%s incoming=%s -> %s', (active, incoming, expected) => {
    expect(shouldPreempt(active, incoming)).toBe(expected);
  });
});
