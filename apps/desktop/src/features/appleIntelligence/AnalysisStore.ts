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
import { computeSnapshotFingerprint } from './AnalysisSnapshotBuilder';
import {
  advanceSetupLifecycle,
  decideSetupContinuity,
  type SetupLifecycleState,
} from './setupLifecycleHysteresis';
import { evaluateAnalysisEligibility } from './snapshotValidation';
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
  AnalysisDiscard,
  AnalysisDiscardCode,
  AnalysisIneligibilityReason,
  AnalysisResult,
  AnalysisSnapshot,
  PriorSetupContext,
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
  /** Set when the most recently submitted snapshot failed the pre-model
   * eligibility gate (snapshotValidation.ts) — the model was never invoked
   * for it. Cleared as soon as a snapshot passes the gate and a request
   * actually starts. Distinct from `lastDiscard`, which covers failures
   * that happen after a request is in flight. */
  lastIneligibility: { reason: AnalysisIneligibilityReason; userMessage: string } | null;
  /** The most recent request that did NOT produce current guidance — decode
   * failure, schema failure, ungrounded plan, stale-context rejection, a
   * transport-level failure, or a superseded/preempted request. Deliberately
   * NOT cleared just because a new request starts (see `runNow`): a trader
   * needs to see "the last attempt failed, here's why" until a *matching*
   * successful result supersedes it or the context materially changes (see
   * `isDiscardStillRelevant`). This replaces the old fire-and-forget
   * `errorMessage` string, which a subsequent `runNow` call unconditionally
   * cleared before a completing-but-discarded result ever got a chance to
   * render — collapsing a diagnosable failure into a bare "unavailable". */
  lastDiscard: AnalysisDiscard | null;
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
  /** Accepted results keyed by snapshot content fingerprint
   * (computeSnapshotFingerprint) — lets a repeated request against
   * unchanged input (the common closed-market "pressed Refresh again" case)
   * reuse the prior accepted result instead of invoking the model again.
   * Bounded like `history`; oldest entries evicted first. Insertion order is
   * Map's iteration order, so `.keys().next()` is always the oldest key. */
  private readonly fingerprintCache = new Map<string, AnalysisResult>();
  /** Tracks the confirmed action per instrument (actionHysteresis.ts) so a
   * lone contrary sample doesn't flip current guidance — the model's
   * prose/confidence may vary call to call, but the action a trader would
   * act on must not, absent a real crossed threshold or a confirmed repeat.
   * `null` until the first result for the current instrument is promoted. */
  private hysteresisState: ActionHysteresisState | null = null;
  /** Tracks the currently-held setup per instrument (setupLifecycleHysteresis.ts)
   * — persists a setup's identity/label across analyses so a sample with no
   * fresh entry doesn't erase a real, still-active setup. Attached to the
   * outgoing snapshot as `priorSetup` (see `withPriorSetup`) so the model
   * continues the analysis instead of starting from a blank slate. `null`
   * when no live, non-terminal setup is currently tracked. */
  private setupLifecycleState: SetupLifecycleState | null = null;

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
      history: [],
      queueDepth: 0,
      lastAnalysisDurationMs: null,
      pendingActionChange: null,
      lastIneligibility: null,
      lastDiscard: null,
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
    // Without this, a late event for a request that started before stop()
    // could still match a stale activeRequestId after a later start()
    // re-subscribes, and submitWork would see isAnalyzing: true and queue
    // instead of running immediately post-remount.
    this.set({
      isAnalyzing: false,
      activeRequestId: null,
      activePriority: null,
      queueDepth: 0,
    });
  }

  /** Manual (or position-critical, in a later phase) request: runs
   * immediately if nothing is active, or preempts/queues per priority. */
  async analyze(snapshot: AnalysisSnapshot, priority: TriggerPriority = 'manual'): Promise<void> {
    await this.submitWork({
      snapshot,
      priority,
      // A content fingerprint, not snapshot.identity.snapshotId — the
      // snapshotId is `${symbol}-${capturedAt}-${counter}`, unique per
      // buildAnalysisSnapshot call, so it can never equal a previously
      // queued item's dedupeKey even when nothing about the snapshot's
      // actual content changed (e.g. two rapid manual Refresh clicks). The
      // scheduler's exact-dedup check needs a key that's stable across
      // content-identical snapshots to enforce "at most once per gesture".
      dedupeKey: computeSnapshotFingerprint(snapshot),
    });
  }

  /** Automatic candle-close request — queued/replaced/dropped per the
   * scheduler's rules rather than always running immediately. */
  async submitCandleClose(snapshot: AnalysisSnapshot): Promise<void> {
    await this.submitWork({
      snapshot,
      priority: 'candle-close',
      dedupeKey: computeSnapshotFingerprint(snapshot),
      replaceKey: `${snapshot.identity.symbol}:${snapshot.identity.timeframe}`,
    });
  }

  private async submitWork(work: QueuedWork): Promise<void> {
    if (!this.bridge) {
      const discard = buildDiscard(
        'bridge-unavailable',
        'Apple Intelligence is not available on this platform.',
        'no-bridge',
        work.snapshot,
      );
      logDiscard(discard);
      this.set({ lastDiscard: discard });
      return;
    }

    // Reject invalid input before it ever reaches the model, the scheduler,
    // or the queue — an ineligible snapshot must never produce a result,
    // however briefly deferred. See snapshotValidation.ts.
    const eligibility = evaluateAnalysisEligibility(work.snapshot);
    if (!eligibility.eligible) {
      this.set({
        lastIneligibility: { reason: eligibility.reason, userMessage: eligibility.userMessage },
      });
      return;
    }
    this.set({ lastIneligibility: null });

    // A repeated request against content-identical input while the market
    // isn't live (typical of a manual Refresh press during a closed market,
    // where nothing about the snapshot has actually changed) must not
    // re-invoke the model — reuse the prior accepted result instead.
    // Scoped to non-live modes only: a live-market request always proceeds,
    // since content can legitimately repeat tick-to-tick (e.g. an unchanged
    // quote between two 1-second polls) without meaning "nothing new to
    // analyze" the way it does when the market is closed. Re-stamped with
    // this snapshot's own context/identity before promotion: the content is
    // proven identical by the fingerprint match, but
    // `context.snapshotSequence` always advances per buildAnalysisSnapshot
    // call, so the cached result's original context would otherwise always
    // fail the staleness gate below. Still goes through the normal
    // promotion path (hysteresis, history), just skipping the model call.
    if (eligibility.mode !== 'live') {
      const fingerprint = computeSnapshotFingerprint(eligibility.snapshot);
      const cached = this.fingerprintCache.get(fingerprint);
      if (cached) {
        const restamped: AnalysisResult = {
          ...cached,
          context: contextFromSnapshot(eligibility.snapshot),
        };
        this.promoteResult(
          restamped,
          contextFromSnapshot(eligibility.snapshot),
          eligibility.snapshot,
          `cache-replay-${fingerprint}`,
          fingerprint,
        );
        return;
      }
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
    const snapshot = this.withPriorSetup(work.snapshot);
    this.lastSnapshot = snapshot;
    this.requestStartedAt = Date.now();
    // A new request starting must NOT blindly erase a still-relevant
    // discard reason from a prior attempt — only a materially different
    // instrument/context (isDiscardStillRelevant) clears it here; a
    // matching successful result clears it on promotion instead (see
    // promoteResult). This is the fix for the bug where an automatic
    // candle-close retry silently wiped a diagnosable failure before the
    // trader ever saw it, collapsing it into a bare "unavailable".
    const { lastDiscard } = this.getState();
    const nextDiscard =
      lastDiscard && !isDiscardStillRelevant(lastDiscard, snapshot) ? null : lastDiscard;
    this.set({ isAnalyzing: true, activePriority: work.priority, lastDiscard: nextDiscard });
    try {
      const { requestId } = await this.bridge.analyze({
        requestId: crypto.randomUUID(),
        payload: snapshot,
      });
      this.set({ activeRequestId: requestId });
    } catch (error) {
      // A rejected analyze() (IPC failure, main-process throw, sidecar
      // crash mid-call) must not leave isAnalyzing stuck true with no
      // activeRequestId — nothing would ever clear it, since there is no
      // requestId for a future native event to match against.
      const discard = buildDiscard(
        'request-failed',
        error instanceof Error ? error.message : 'Analysis request failed to start.',
        'no-request-id',
        snapshot,
      );
      logDiscard(discard);
      this.set({
        isAnalyzing: false,
        activeRequestId: null,
        activePriority: null,
        lastDiscard: discard,
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
    // Clear single-flight state unconditionally, regardless of whether the
    // native cancel() call succeeded: a `cancelled` event may never arrive
    // (sidecar gone, IPC failure), and leaving isAnalyzing/activeRequestId
    // set would strand the store. Clearing activeRequestId here also stops
    // submitWork's preemption path (cancel() -> runNow()) from racing itself
    // — a late completed/cancelled event for this now-superseded requestId
    // can no longer match `event.requestId === activeRequestId` in
    // handleEvent once runNow assigns a new one.
    this.set({ isAnalyzing: false, activeRequestId: null, activePriority: null });
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
        this.handleCompleted(event.payload, event.requestId);
        break;
      case 'cancelled':
        this.finishActive();
        break;
      case 'failed': {
        // Captured before finishActive() for the same reason handleCompleted
        // captures completedSnapshot first: finishActive() synchronously
        // starts the next queued request, which runs its own
        // isDiscardStillRelevant check against a snapshot this discard
        // hasn't been recorded against yet.
        const failedSnapshot = this.lastSnapshot;
        const discard = buildDiscard(
          'runtime-failed',
          event.error?.message ?? 'Analysis failed.',
          event.requestId,
          failedSnapshot,
        );
        logDiscard(discard, { nativeErrorCode: event.error?.code });
        this.finishActive();
        this.set({ lastDiscard: discard });
        break;
      }
      default:
        break;
    }
  }

  private handleCompleted(payload: unknown, requestId: string): void {
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

    const fingerprint = completedSnapshot ? computeSnapshotFingerprint(completedSnapshot) : null;

    const result = parseAnalysisResult(payload);
    if (!result) {
      const discard = buildDiscard(
        'invalid-result',
        'Analysis returned an invalid result and was discarded.',
        requestId,
        completedSnapshot,
        fingerprint,
      );
      logDiscard(discard);
      this.set({ lastDiscard: discard });
      return;
    }

    if (!completedSnapshot) return;
    const validated = this.validateResult(result, completedSnapshot, requestId, fingerprint);
    if (!validated) return;

    this.promoteResult(
      validated,
      contextFromSnapshot(completedSnapshot),
      completedSnapshot,
      requestId,
      fingerprint,
    );
  }

  /** Structural + grounding + decision-invariant validation applied to
   * every completed result before it can be promoted to current guidance. */
  private validateResult(
    result: AnalysisResult,
    snapshot: AnalysisSnapshot,
    requestId: string,
    fingerprint: string | null,
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
      const discard = buildDiscard(
        'ungrounded-plan',
        'Analysis returned an ungrounded Trade Desk plan and was discarded.',
        requestId,
        snapshot,
        fingerprint,
      );
      logDiscard(discard);
      this.set({ lastDiscard: discard });
      return null;
    }
    // `snapshot` already passed evaluateAnalysisEligibility at submission
    // time (submitWork rejects ineligible snapshots before a request is
    // ever sent), so a present `options.selectedContract` here necessarily
    // had a valid quote — this is not re-validating, just checking presence.
    const hasValidOptionsQuote = Boolean(
      (snapshot.options as { selectedContract?: unknown } | undefined)?.selectedContract,
    );
    return enforceTradeDeskInvariants(grounded, Boolean(snapshot.position), hasValidOptionsQuote);
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
    requestId: string,
    fingerprint: string | null,
  ): void {
    const isCurrent = isResultCurrent(result.context, currentContext);

    this.pushHistory({ result, wasPromoted: isCurrent });
    if (!isCurrent) {
      // Current: safe to update guidance. Stale: retained above for
      // diagnostics/history only, per lifecycle-and-concurrency.md — it
      // must never replace current guidance. Still worth a discard record —
      // a trader deserves to know the last analysis was superseded rather
      // than silently vanishing into a bare "unavailable".
      const discard = buildDiscard(
        'stale-context',
        'The latest analysis no longer matches the current chart context and was not applied.',
        requestId,
        snapshot,
        fingerprint,
      );
      logDiscard(discard, {
        resultContext: result.context,
        currentContext,
      });
      this.set({ lastDiscard: discard });
      return;
    }
    // A successful, current result supersedes any discard recorded for this
    // same instrument/context — the trader now has fresh, valid guidance,
    // so the prior failure reason is no longer the most relevant thing to
    // show.
    const { lastDiscard } = this.getState();
    if (lastDiscard && isDiscardStillRelevant(lastDiscard, snapshot)) {
      this.set({ lastDiscard: null });
    }

    const key = hysteresisKey(snapshot);
    const state = this.hysteresisState?.key === key ? this.hysteresisState : null;
    const decision = decideActionHysteresis(state, result, snapshot);
    this.hysteresisState = advanceActionHysteresis(state, result, snapshot, decision);

    // Setup-lifecycle continuity is a separate tracker from action
    // hysteresis (a different concern — see setupLifecycleHysteresis.ts) but
    // shares the same instrument key and the same "only current results
    // advance state" gating.
    const setupState = this.setupLifecycleState?.key === key ? this.setupLifecycleState : null;
    const setupDecision = decideSetupContinuity(setupState, result, snapshot);
    this.setupLifecycleState = advanceSetupLifecycle(setupState, result, snapshot, setupDecision);

    const promoted =
      decision.kind === 'hold' ? synthesizeHeldResult(state!.confirmedResult, result) : result;
    const pendingActionChange =
      decision.kind === 'hold' ? { action: decision.pendingAction } : null;

    this.set({
      latestResult: promoted,
      latestTriggerKind: snapshot.trigger.kind,
      pendingActionChange,
    });
    this.cacheByFingerprint(computeSnapshotFingerprint(snapshot), promoted);
  }

  private cacheByFingerprint(fingerprint: string, result: AnalysisResult): void {
    this.fingerprintCache.delete(fingerprint); // re-insert to refresh recency order
    this.fingerprintCache.set(fingerprint, result);
    if (this.fingerprintCache.size > MAX_HISTORY) {
      const oldestKey = this.fingerprintCache.keys().next().value;
      if (oldestKey !== undefined) this.fingerprintCache.delete(oldestKey);
    }
  }

  /** Attaches the currently-tracked setup for this instrument (if any, and
   * if it hasn't completed/invalidated) as `priorSetup` so the model
   * continues the analysis rather than starting from a blank slate. A
   * different instrument (symbol/timeframe/contract) never sees another
   * instrument's setup — matched via the same `hysteresisKey` the tracker
   * itself is keyed by. */
  private withPriorSetup(snapshot: AnalysisSnapshot): AnalysisSnapshot {
    const state = this.setupLifecycleState;
    if (!state || state.key !== hysteresisKey(snapshot)) return snapshot;
    const priorSetup: PriorSetupContext = {
      setupId: state.setupId,
      direction: state.direction,
      label: state.label,
      lifecycle: state.lifecycle,
      detectedAt: state.detectedAt,
      triggeredAt: state.triggeredAt,
      invalidationLevel: state.invalidationLevel,
    };
    return { ...snapshot, priorSetup };
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

function buildDiscard(
  code: AnalysisDiscardCode,
  message: string,
  requestId: string,
  snapshot: AnalysisSnapshot | null,
  fingerprint: string | null = null,
): AnalysisDiscard {
  return {
    code,
    message,
    requestId,
    fingerprint,
    symbol: snapshot?.identity.symbol ?? 'unknown',
    timeframe: snapshot?.identity.timeframe ?? 'unknown',
    selectedContractSymbol: snapshot?.identity.selectedContractSymbol,
    positionVersion: snapshot?.identity.positionVersion ?? 0,
    occurredAt: new Date().toISOString(),
  };
}

/** A discard stays visible across a new request starting (see `runNow`) —
 * it's only superseded when a NEW request targets a materially different
 * instrument/context (symbol, timeframe, contract, or position revision
 * changed) or when a matching successful result is promoted for the same
 * one (see `promoteResult`). This is what stops the old bug where simply
 * starting the next automatic candle-close/manual run silently erased a
 * still-relevant discard reason before the trader ever saw it. */
function isDiscardStillRelevant(discard: AnalysisDiscard, snapshot: AnalysisSnapshot): boolean {
  return (
    discard.symbol === snapshot.identity.symbol &&
    discard.timeframe === snapshot.identity.timeframe &&
    discard.selectedContractSymbol === snapshot.identity.selectedContractSymbol &&
    discard.positionVersion === snapshot.identity.positionVersion
  );
}

/** Structured, single-line diagnostic for every point a request fails to
 * produce current guidance — deliberately never includes raw model output,
 * snapshot content, or prompt text (security-boundary.md "Logging"), only
 * identity/metadata, matching the Swift shim's own stderr-only diagnostic
 * pattern (AnalysisRunner.swift's analysis_run_error/analysis_run_truncation
 * logs). Console-only; never sent over any wire. */
function logDiscard(discard: AnalysisDiscard, detail?: Record<string, unknown>): void {
  console.warn('[analysis-store] discard', {
    code: discard.code,
    requestId: discard.requestId,
    fingerprint: discard.fingerprint,
    symbol: discard.symbol,
    timeframe: discard.timeframe,
    selectedContractSymbol: discard.selectedContractSymbol,
    positionVersion: discard.positionVersion,
    ...detail,
  });
}

function toAIAvailability(result: { state: string; reason?: string }): AIAvailability {
  if (result.state === 'ready') return { state: 'ready' };
  if (result.state === 'incompatible')
    return { state: 'incompatible', reason: result.reason ?? 'unknown' };
  if (result.state === 'degraded') return { state: 'degraded', reason: result.reason ?? 'unknown' };
  return { state: 'unavailable', reason: result.reason ?? 'unknown' };
}
