// Canonical spec: docs/apple-intelligence/lifecycle-and-concurrency.md
// (single-flight scheduler) and architecture.md (AnalysisScheduler —
// "single-flight queueing, priority, replacement, deduplication, deadlines,
// and stale-work cancellation"). Pure in-memory queue logic: no IPC, no
// timers — the caller drives it by calling submit()/dequeueNext() and
// owns actually running work.
import type { AnalysisSnapshot, TriggerPriority } from './types';

const PRIORITY_RANK: Record<TriggerPriority, number> = {
  'position-critical': 0,
  manual: 1,
  'candle-close': 2,
  background: 3,
};

export interface QueuedWork {
  snapshot: AnalysisSnapshot;
  priority: TriggerPriority;
  /** Identifies identical work (e.g. a content hash of the snapshot) —
   * an exact duplicate already queued is dropped rather than re-added. */
  dedupeKey: string;
  /** For candle-close work only: identifies the "slot" (symbol+timeframe)
   * a newer close should replace an older queued one in, even though the
   * two have different dedupeKeys (different candle, different content).
   * Other priorities leave this undefined — they are never replaced by slot. */
  replaceKey?: string;
}

const DEFAULT_MAX_QUEUE_SIZE = 10;

/**
 * Bounded priority queue implementing the scheduling rules from
 * lifecycle-and-concurrency.md. Does not run anything itself — the caller
 * pulls with `dequeueNext()` when ready to start the next single-flight
 * request.
 */
export class AnalysisScheduler {
  private queue: QueuedWork[] = [];

  constructor(private readonly maxQueueSize: number = DEFAULT_MAX_QUEUE_SIZE) {}

  get size(): number {
    return this.queue.length;
  }

  peekAll(): readonly QueuedWork[] {
    return this.queue;
  }

  /**
   * Enqueues work, applying replacement and dedup rules. Returns the work
   * that was actually queued, or null if it was dropped: an exact
   * duplicate (same dedupeKey) is dropped outright; a full queue drops the
   * new submission unless a strictly lower-priority item can be evicted for it.
   */
  submit(work: QueuedWork): QueuedWork | null {
    if (this.queue.some((item) => item.dedupeKey === work.dedupeKey)) {
      return null;
    }

    // A newer candle-close request replaces an older queued candle-close
    // request for the same symbol+timeframe slot.
    if (work.replaceKey !== undefined) {
      const staleIndex = this.queue.findIndex((item) => item.replaceKey === work.replaceKey);
      if (staleIndex !== -1) {
        this.queue[staleIndex] = work;
        this.sortByPriority();
        return work;
      }
    }

    if (this.queue.length >= this.maxQueueSize) {
      const droppableIndex = this.lowestPriorityIndexBelow(work.priority);
      if (droppableIndex === -1) {
        // Queue is full of work at least as important as this submission —
        // drop the new work rather than evict something more important.
        return null;
      }
      this.queue.splice(droppableIndex, 1);
    }

    this.queue.push(work);
    this.sortByPriority();
    return work;
  }

  /** Removes and returns the highest-priority queued work, or null if empty. */
  dequeueNext(): QueuedWork | null {
    return this.queue.shift() ?? null;
  }

  /** Drops all queued background work — used when it can no longer affect
   * the current view (lifecycle-and-concurrency.md: "drop stale background
   * work instead of accumulating latency"). */
  dropBackgroundWork(): void {
    this.queue = this.queue.filter((item) => item.priority !== 'background');
  }

  clear(): void {
    this.queue = [];
  }

  private sortByPriority(): void {
    this.queue.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  }

  private lowestPriorityIndexBelow(priority: TriggerPriority): number {
    let worstIndex = -1;
    let worstRank = -1;
    this.queue.forEach((item, index) => {
      const rank = PRIORITY_RANK[item.priority];
      if (rank > PRIORITY_RANK[priority] && rank > worstRank) {
        worstRank = rank;
        worstIndex = index;
      }
    });
    return worstIndex;
  }
}

/**
 * Whether currently-active work of `activePriority` should be preempted by
 * newly-submitted work of `incomingPriority`, per lifecycle-and-concurrency.md:
 * position-critical may preempt candle-close/background; manual may preempt
 * background but must not silently override active position-critical work.
 */
export function shouldPreempt(
  activePriority: TriggerPriority,
  incomingPriority: TriggerPriority,
): boolean {
  if (incomingPriority === 'position-critical') {
    return activePriority === 'candle-close' || activePriority === 'background';
  }
  if (incomingPriority === 'manual') {
    return activePriority === 'background';
  }
  return false;
}
