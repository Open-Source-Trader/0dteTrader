import { Store } from '../../core/observable';
import type {
  AppleIntelligenceBridge,
  NativeEventPayload,
} from '../../core/desktop/appleIntelligence';
import {
  advanceActionHysteresis,
  decideActionHysteresis,
  hysteresisKey,
  synthesizeHeldResult,
  type ActionHysteresisState,
} from './actionHysteresis';
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
  TradeDeskAction,
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
  /** A differing action seen in the latest sample but not yet confirmed
   * (actionHysteresis.ts) — `latestResult`'s action is still the
   * previously-confirmed one; this surfaces the candidate so the UI can
   * show "confirming" feedback without changing the primary action badge.
   * `null` when the latest sample matched the confirmed action (nothing
   * pending) or promoted immediately (threshold crossed / no prior state). */
  pendingActionChange: { action: TradeDeskAction } | null;
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
  /** Tracks the confirmed action per instrument (actionHysteresis.ts) so a
   * lone contrary sample doesn't flip current guidance — the model's
   * prose/confidence may vary call to call, but the action a trader would
   * act on must not, absent a real crossed threshold or a confirmed repeat.
   * `null` until the first result for the current instrument is promoted. */
  private hysteresisState: ActionHysteresisState | null = null;

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
      pendingActionChange: null,
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
    try {
      const { requestId } = await this.bridge.analyze({
        requestId: crypto.randomUUID(),
        payload: work.snapshot,
      });
      this.set({ activeRequestId: requestId });
    } catch (error) {
      // A rejected analyze() (IPC failure, main-process throw, sidecar
      // crash mid-call) must not leave isAnalyzing stuck true with no
      // activeRequestId — nothing would ever clear it, since there is no
      // requestId for a future native event to match against.
      this.set({
        isAnalyzing: false,
        activeRequestId: null,
        activePriority: null,
        errorMessage: error instanceof Error ? error.message : 'Analysis request failed to start.',
      });
    }
  }

  private async runNextQueued(): Promise<void> {
    const next = this.scheduler.dequeueNext();
    this.set({ queueDepth: this.scheduler.size });
    if (next) await this.runNow(next);
  }

  async cancel(): Promise<void> {
    const { activeRequestId } = this.getState();
    if (!activeRequestId) return;
    try {
      await this.bridge?.cancel(activeRequestId);
    } catch {
      // A rejected cancel() (IPC failure, sidecar already gone) must not
      // block the caller from proceeding — submitWork's preemption path
      // (cancel() then runNow()) must still start the new work even when
      // cancelling the old, likely-orphaned request failed.
    }
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
    // Captured before finishActive(): finishActive() synchronously starts
    // the next queued request (runNextQueued -> runNow), which reassigns
    // this.lastSnapshot to the QUEUED work's snapshot before this function
    // gets a chance to use it — runNow's work is synchronous up to its
    // first await, so this isn't a race that only sometimes happens, it
    // reassigns every time a queued request exists at completion time.
    // Validating/promoting must use the snapshot that produced THIS result.
    const completedSnapshot = this.lastSnapshot;
    this.finishActive();
    this.set({ lastAnalysisDurationMs: durationMs });

    const result = parseAnalysisResult(payload);
    if (!result) {
      this.set({ errorMessage: 'Analysis returned an invalid result and was discarded.' });
      return;
    }

    if (!completedSnapshot) return;
    const validated = this.validateResult(result, completedSnapshot);
    if (!validated) return;

    this.promoteResult(validated, contextFromSnapshot(completedSnapshot), completedSnapshot);
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
   * still matches. Current results additionally pass through action
   * hysteresis (actionHysteresis.ts) before promotion: a lone contrary
   * sample is held back rather than immediately flipping the action a
   * trader would act on. */
  private promoteResult(
    result: AnalysisResult,
    currentContext: AnalysisContextIdentity,
    snapshot: AnalysisSnapshot,
  ): void {
    const isCurrent = isResultCurrent(result.context, currentContext);

    this.pushHistory({ result, wasPromoted: isCurrent });
    if (!isCurrent) return;
    // Current: safe to update guidance. Stale: retained above for
    // diagnostics/history only, per lifecycle-and-concurrency.md — it
    // must never replace current guidance.

    const key = hysteresisKey(snapshot);
    const state = this.hysteresisState?.key === key ? this.hysteresisState : null;
    const decision = decideActionHysteresis(state, result, snapshot);
    this.hysteresisState = advanceActionHysteresis(state, result, snapshot, decision);

    const promoted =
      decision.kind === 'hold' ? synthesizeHeldResult(state!.confirmedResult, result) : result;
    const pendingActionChange =
      decision.kind === 'hold' ? { action: decision.pendingAction } : null;

    this.set({
      latestResult: promoted,
      latestTriggerKind: snapshot.trigger.kind,
      pendingActionChange,
    });
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
