import { Store } from '../../core/observable';
import type {
  AppleIntelligenceBridge,
  NativeEventPayload,
} from '../../core/desktop/appleIntelligence';
import { isResultCurrent } from './stalenessGate';
import { parseAnalysisResult, rejectUngroundedLevels } from './validation';
import type {
  AIAvailability,
  AnalysisContextIdentity,
  AnalysisResult,
  AnalysisSnapshot,
} from './types';

interface AnalysisStoreState {
  availability: AIAvailability;
  isAnalyzing: boolean;
  activeRequestId: string | null;
  latestResult: AnalysisResult | null;
  errorMessage: string | null;
}

/**
 * Feature-owned presentation state (AnalysisStore, architecture.md). Owns
 * request lifecycle, cancellation, and the staleness gate. Cannot mutate
 * authoritative trading state and cannot promote a result that fails the
 * staleness gate or grounding validation.
 */
export class AnalysisStore extends Store<AnalysisStoreState> {
  private unsubscribeEvents: (() => void) | null = null;
  private lastSnapshot: AnalysisSnapshot | null = null;

  constructor(private readonly bridge: AppleIntelligenceBridge | null) {
    super({
      availability: bridge
        ? { state: 'unavailable', reason: 'not-checked' }
        : { state: 'unavailable', reason: 'bridge-not-present' },
      isAnalyzing: false,
      activeRequestId: null,
      latestResult: null,
      errorMessage: null,
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
  }

  async analyze(snapshot: AnalysisSnapshot): Promise<void> {
    if (!this.bridge) {
      this.set({ errorMessage: 'Apple Intelligence is not available on this platform.' });
      return;
    }
    if (this.getState().isAnalyzing) return;

    this.lastSnapshot = snapshot;
    this.set({ isAnalyzing: true, errorMessage: null });
    const { requestId } = await this.bridge.analyze({
      requestId: crypto.randomUUID(),
      payload: snapshot,
    });
    this.set({ activeRequestId: requestId });
  }

  async cancel(): Promise<void> {
    const { activeRequestId } = this.getState();
    if (!activeRequestId) return;
    await this.bridge?.cancel(activeRequestId);
  }

  private handleEvent(event: NativeEventPayload): void {
    const { activeRequestId } = this.getState();
    if (event.requestId !== activeRequestId) return;

    switch (event.event) {
      case 'completed':
        this.handleCompleted(event.payload);
        break;
      case 'cancelled':
        this.set({ isAnalyzing: false, activeRequestId: null });
        break;
      case 'failed':
        this.set({
          isAnalyzing: false,
          activeRequestId: null,
          errorMessage: event.error?.message ?? 'Analysis failed.',
        });
        break;
      default:
        break;
    }
  }

  private handleCompleted(payload: unknown): void {
    this.set({ isAnalyzing: false, activeRequestId: null });

    const result = parseAnalysisResult(payload);
    if (!result) {
      this.set({ errorMessage: 'Analysis returned an invalid result and was discarded.' });
      return;
    }

    if (!this.lastSnapshot) return;
    const currentContext = contextFromSnapshot(this.lastSnapshot);
    if (!isResultCurrent(result.context, currentContext)) {
      // Stale: context moved on while the model was working. Discarded from
      // current guidance rather than promoted (lifecycle-and-concurrency.md).
      return;
    }

    const grounded = rejectUngroundedLevels(result, this.lastSnapshot.levels);
    this.set({ latestResult: grounded });
  }
}

function contextFromSnapshot(snapshot: AnalysisSnapshot): AnalysisContextIdentity {
  return {
    symbol: snapshot.identity.symbol,
    timeframe: snapshot.identity.timeframe,
    snapshotSequence: snapshot.identity.snapshotSequence,
    candleCloseTime: snapshot.identity.candleCloseTime,
    positionVersion: snapshot.identity.positionVersion,
    strategyPolicyVersion: snapshot.identity.strategyPolicyVersion,
  };
}

function toAIAvailability(result: { state: string; reason?: string }): AIAvailability {
  if (result.state === 'ready') return { state: 'ready' };
  if (result.state === 'incompatible')
    return { state: 'incompatible', reason: result.reason ?? 'unknown' };
  if (result.state === 'degraded') return { state: 'degraded', reason: result.reason ?? 'unknown' };
  return { state: 'unavailable', reason: result.reason ?? 'unknown' };
}
