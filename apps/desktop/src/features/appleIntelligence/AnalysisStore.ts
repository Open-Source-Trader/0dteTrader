import { Store } from '../../core/observable';
import type {
  AppleIntelligenceBridge,
  NativeEventPayload,
} from '../../core/desktop/appleIntelligence';
import { isResultCurrent } from './stalenessGate';
import {
  enforceTradeDeskInvariants,
  isTradeDeskPlanGrounded,
  parseAnalysisResult,
  rejectUngroundedLevels,
} from './validation';
import { AnalysisScheduler, shouldPreempt, type QueuedWork } from './AnalysisScheduler';
import type {
  AIAvailability,
  AnalysisContextIdentity,
  AnalysisResult,
  AnalysisSnapshot,
  TriggerKind,
  TriggerPriority,
} from './types';

const MAX_HISTORY = 20;

export interface HistoryEntry {
  result: AnalysisResult;
  /** False when the result failed the staleness gate at completion time —
   * retained for local diagnostics/history but never promoted to
   * latestResult (lifecycle-and-concurrency.md: "may be retained for local
   * diagnostics or history. It must never replace current guidance"). */
  wasPromoted: boolean;
}

interface AnalysisStoreState {
  availability: AIAvailability;
  isAnalyzing: boolean;
  activeRequestId: string | null;
  activePriority: TriggerPriority | null;
  latestResult: AnalysisResult | null;
  /** Trigger kind of the promoted latestResult — lets the UI label
   * automatic (candle-close/position) results as such. */
  latestTriggerKind: TriggerKind | null;
  errorMessage: string | null;
  history: HistoryEntry[];
  queueDepth: number;
  lastAnalysisDurationMs: number | null;
}

/**
 * Feature-owned presentation state (AnalysisStore, architecture.md). Owns
 * request lifecycle, cancellation, the staleness gate, and — as of Phase 4 —
 * the bounded single-flight scheduler for automatic (candle-close/
 * background) work alongside manual/position-critical requests. Cannot
 * mutate authoritative trading state and cannot promote a result that fails
 * the staleness gate or grounding validation.
 */
export class AnalysisStore extends Store<AnalysisStoreState> {
  private unsubscribeEvents: (() => void) | null = null;
  private lastSnapshot: AnalysisSnapshot | null = null;
  private readonly scheduler = new AnalysisScheduler();
  private requestStartedAt: number | null = null;

  constructor(private readonly bridge: AppleIntelligenceBridge | null) {
    super({
      availability: bridge
        ? { state: 'unavailable', reason: 'not-checked' }
        : { state: 'unavailable', reason: 'bridge-not-present' },
      isAnalyzing: false,
      activeRequestId: null,
      activePriority: null,
      latestResult: null,
      latestTriggerKind: null,
      errorMessage: null,
      history: [],
      queueDepth: 0,
      lastAnalysisDurationMs: null,
    });
  }

  async refreshAvailability(): Promise<void> {
    if (!this.bridge) return;
    const result = await this.bridge.getAvailability();
    this.set({ availability: toAIAvailability(result) });
  }

  /** Subscribes to native events once; safe to call multiple times. */
  start(): void {
    if (this.unsubscribeEvents || !this.bridge) return;
    this.unsubscribeEvents = this.bridge.subscribe((event) => this.handleEvent(event));
  }

  stop(): void {
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    this.scheduler.clear();
  }

  /** Manual (or position-critical, in a later phase) request: runs
   * immediately if nothing is active, or preempts/queues per priority. */
  async analyze(snapshot: AnalysisSnapshot, priority: TriggerPriority = 'manual'): Promise<void> {
    await this.submitWork({
      snapshot,
      priority,
      dedupeKey: snapshot.identity.snapshotId,
    });
  }

  /** Automatic candle-close request — queued/replaced/dropped per the
   * scheduler's rules rather than always running immediately. */
  async submitCandleClose(snapshot: AnalysisSnapshot): Promise<void> {
    await this.submitWork({
      snapshot,
      priority: 'candle-close',
      dedupeKey: snapshot.identity.snapshotId,
      replaceKey: `${snapshot.identity.symbol}:${snapshot.identity.timeframe}`,
    });
  }

  private async submitWork(work: QueuedWork): Promise<void> {
    if (!this.bridge) {
      this.set({ errorMessage: 'Apple Intelligence is not available on this platform.' });
      return;
    }

    const { isAnalyzing, activePriority } = this.getState();
    if (isAnalyzing && activePriority) {
      if (shouldPreempt(activePriority, work.priority)) {
        await this.cancel();
        await this.runNow(work);
        return;
      }
      this.scheduler.submit(work);
      this.set({ queueDepth: this.scheduler.size });
      return;
    }

    await this.runNow(work);
  }

  private async runNow(work: QueuedWork): Promise<void> {
    if (!this.bridge) return;
    this.lastSnapshot = work.snapshot;
    this.requestStartedAt = Date.now();
    this.set({ isAnalyzing: true, activePriority: work.priority, errorMessage: null });
    const { requestId } = await this.bridge.analyze({
      requestId: crypto.randomUUID(),
      payload: work.snapshot,
    });
    this.set({ activeRequestId: requestId });
  }

  private async runNextQueued(): Promise<void> {
    const next = this.scheduler.dequeueNext();
    this.set({ queueDepth: this.scheduler.size });
    if (next) await this.runNow(next);
  }

  async cancel(): Promise<void> {
    const { activeRequestId } = this.getState();
    if (!activeRequestId) return;
    await this.bridge?.cancel(activeRequestId);
  }

  /** Drops queued background work that can no longer affect the current
   * view — e.g. the user switched symbols. */
  discardStaleBackgroundWork(): void {
    this.scheduler.dropBackgroundWork();
    this.set({ queueDepth: this.scheduler.size });
  }

  private handleEvent(event: NativeEventPayload): void {
    const { activeRequestId } = this.getState();
    if (event.requestId !== activeRequestId) return;

    switch (event.event) {
      case 'completed':
        this.handleCompleted(event.payload);
        break;
      case 'cancelled':
        this.finishActive();
        break;
      case 'failed':
        this.finishActive();
        this.set({ errorMessage: event.error?.message ?? 'Analysis failed.' });
        break;
      default:
        break;
    }
  }

  private handleCompleted(payload: unknown): void {
    const durationMs = this.requestStartedAt ? Date.now() - this.requestStartedAt : null;
    this.finishActive();
    this.set({ lastAnalysisDurationMs: durationMs });

    const result = parseAnalysisResult(payload);
    if (!result) {
      this.set({ errorMessage: 'Analysis returned an invalid result and was discarded.' });
      return;
    }

    if (!this.lastSnapshot) return;
    const validated = this.validateResult(result, this.lastSnapshot);
    if (!validated) return;

    this.promoteResult(validated, contextFromSnapshot(this.lastSnapshot));
  }

  /** Structural + grounding + decision-invariant validation applied to
   * every completed result before it can be promoted to current guidance. */
  private validateResult(
    result: AnalysisResult,
    snapshot: AnalysisSnapshot,
  ): AnalysisResult | null {
    const enriched: AnalysisResult = {
      ...result,
      context: {
        ...result.context,
        snapshotId: result.context.snapshotId ?? snapshot.identity.snapshotId,
        selectedContractSymbol:
          result.context.selectedContractSymbol ?? snapshot.identity.selectedContractSymbol,
      },
    };
    const grounded = rejectUngroundedLevels(enriched, snapshot.levels);
    if (!isTradeDeskPlanGrounded(grounded, snapshot.levels)) {
      this.set({
        errorMessage: 'Analysis returned an ungrounded Trade Desk plan and was discarded.',
      });
      return null;
    }
    return enforceTradeDeskInvariants(grounded, Boolean(snapshot.position));
  }

  /** Applies the staleness gate and promotes/records a validated result
   * against `currentContext` — the authoritative identity of whatever
   * snapshot is current *right now*, which may differ from the result's own
   * `context` if a newer request was already submitted by the time this one
   * completed. A result may update current guidance only when its context
   * still matches. */
  private promoteResult(result: AnalysisResult, currentContext: AnalysisContextIdentity): void {
    const isCurrent = isResultCurrent(result.context, currentContext);

    this.pushHistory({ result, wasPromoted: isCurrent });
    if (isCurrent) {
      // Current: safe to update guidance. Stale: retained above for
      // diagnostics/history only, per lifecycle-and-concurrency.md — it
      // must never replace current guidance.
      this.set({
        latestResult: result,
        latestTriggerKind: this.lastSnapshot?.trigger.kind ?? null,
      });
    }
  }

  private pushHistory(entry: HistoryEntry): void {
    const history = [entry, ...this.getState().history].slice(0, MAX_HISTORY);
    this.set({ history });
  }

  /** Common cleanup after any terminal event, then starts the next queued
   * work (if any) — the single-flight invariant. */
  private finishActive(): void {
    this.set({ isAnalyzing: false, activeRequestId: null, activePriority: null });
    void this.runNextQueued();
  }
}

function contextFromSnapshot(snapshot: AnalysisSnapshot): AnalysisContextIdentity {
  return {
    snapshotId: snapshot.identity.snapshotId,
    symbol: snapshot.identity.symbol,
    timeframe: snapshot.identity.timeframe,
    snapshotSequence: snapshot.identity.snapshotSequence,
    candleCloseTime: snapshot.identity.candleCloseTime,
    positionVersion: snapshot.identity.positionVersion,
    strategyPolicyVersion: snapshot.identity.strategyPolicyVersion,
    selectedContractSymbol: snapshot.identity.selectedContractSymbol,
  };
}

function toAIAvailability(result: { state: string; reason?: string }): AIAvailability {
  if (result.state === 'ready') return { state: 'ready' };
  if (result.state === 'incompatible')
    return { state: 'incompatible', reason: result.reason ?? 'unknown' };
  if (result.state === 'degraded') return { state: 'degraded', reason: result.reason ?? 'unknown' };
  return { state: 'unavailable', reason: result.reason ?? 'unknown' };
}
