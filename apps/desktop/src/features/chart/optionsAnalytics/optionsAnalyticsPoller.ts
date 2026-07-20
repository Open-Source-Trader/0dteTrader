import type { OptionsAnalyticsSnapshot } from '@0dtetrader/shared-types';
import { validateOptionsAnalyticsSnapshot } from './optionsAnalyticsValidation';

export interface OptionsAnalyticsPollParams {
  symbol: string;
  expiration: string;
  refreshSeconds: number;
}

export interface OptionsAnalyticsPollState {
  snapshot: OptionsAnalyticsSnapshot | null;
  isLoading: boolean;
  retained: boolean;
  errorMessage: string | null;
}

export interface OptionsAnalyticsVisibilitySource {
  isHidden(): boolean;
  subscribe(listener: () => void): () => void;
}

type FetchSnapshot = (
  symbol: string,
  expiration: string,
  signal: AbortSignal,
) => Promise<OptionsAnalyticsSnapshot>;

const INITIAL_STATE: OptionsAnalyticsPollState = {
  snapshot: null,
  isLoading: false,
  retained: false,
  errorMessage: null,
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exactKeyMatches(
  snapshot: OptionsAnalyticsSnapshot,
  params: OptionsAnalyticsPollParams,
): boolean {
  return snapshot.scope.symbol === params.symbol && snapshot.scope.expiration === params.expiration;
}

/**
 * A failed refresh may retain one exact snapshot for at most two poll windows.
 * Settlement is a hard boundary; an expired point-in-time model is never kept.
 */
export function isRetainableOptionsAnalyticsSnapshot(
  snapshot: OptionsAnalyticsSnapshot,
  params: OptionsAnalyticsPollParams,
  nowMs: number,
): boolean {
  if (!exactKeyMatches(snapshot, params)) return false;
  const observedAt = Date.parse(snapshot.scope.observedAt);
  const settlementAt = Date.parse(snapshot.scope.settlementAt);
  if (!Number.isFinite(observedAt) || !Number.isFinite(settlementAt)) return false;
  if (nowMs >= settlementAt) return false;
  const maximumAgeMs = Math.max(15, params.refreshSeconds) * 2_000;
  return observedAt <= nowMs && nowMs - observedAt <= maximumAgeMs;
}

function documentVisibilitySource(): OptionsAnalyticsVisibilitySource {
  if (typeof document === 'undefined') {
    return { isHidden: () => false, subscribe: () => () => undefined };
  }
  return {
    isHidden: () => document.visibilityState === 'hidden',
    subscribe: (listener) => {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
  };
}

/** Owns one abortable request generation and schedules only after it settles. */
export class OptionsAnalyticsPoller {
  private state: OptionsAnalyticsPollState = INITIAL_STATE;
  private params: OptionsAnalyticsPollParams | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private readonly listeners = new Set<(state: OptionsAnalyticsPollState) => void>();
  private readonly unsubscribeVisibility: () => void;

  constructor(
    private readonly fetchSnapshot: FetchSnapshot,
    private readonly visibility: OptionsAnalyticsVisibilitySource = documentVisibilitySource(),
  ) {
    this.unsubscribeVisibility = visibility.subscribe(() => this.handleVisibilityChange());
  }

  getState(): OptionsAnalyticsPollState {
    return this.state;
  }

  subscribe(listener: (state: OptionsAnalyticsPollState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  start(params: OptionsAnalyticsPollParams): void {
    this.cancelActiveGeneration();
    this.params = { ...params, symbol: params.symbol.toUpperCase().trim() };
    this.setState(INITIAL_STATE);
    if (!this.params.symbol || this.visibility.isHidden()) return;
    void this.poll(this.generation);
  }

  stop(): void {
    this.params = null;
    this.cancelActiveGeneration();
    this.unsubscribeVisibility();
    this.listeners.clear();
  }

  private setState(next: OptionsAnalyticsPollState): void {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }

  private cancelActiveGeneration(): void {
    this.generation += 1;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
  }

  private handleVisibilityChange(): void {
    if (!this.params) return;
    if (this.visibility.isHidden()) {
      this.cancelActiveGeneration();
      this.setState({ ...this.state, isLoading: false });
      return;
    }
    this.cancelActiveGeneration();
    void this.poll(this.generation);
  }

  private async poll(generation: number): Promise<void> {
    const params = this.params;
    if (!params || generation !== this.generation || this.visibility.isHidden()) return;
    const controller = new AbortController();
    this.controller = controller;
    this.setState({ ...this.state, isLoading: true, errorMessage: null });
    try {
      const value = await this.fetchSnapshot(params.symbol, params.expiration, controller.signal);
      if (generation !== this.generation || params !== this.params) return;
      const snapshot = validateOptionsAnalyticsSnapshot(value, params.symbol, params.expiration);
      if (!exactKeyMatches(snapshot, params)) {
        this.setState({
          snapshot: null,
          isLoading: false,
          retained: false,
          errorMessage:
            'Options analytics response did not match the active symbol and expiration.',
        });
        return;
      }
      this.setState({ snapshot, isLoading: false, retained: false, errorMessage: null });
    } catch (error) {
      if (generation !== this.generation || params !== this.params) return;
      if (isAbortError(error)) {
        this.setState({ ...this.state, isLoading: false });
      } else {
        const retained =
          this.state.snapshot !== null &&
          isRetainableOptionsAnalyticsSnapshot(this.state.snapshot, params, Date.now());
        this.setState({
          snapshot: retained ? this.state.snapshot : null,
          isLoading: false,
          retained,
          errorMessage: errorText(error),
        });
      }
    } finally {
      const shouldSchedule =
        generation === this.generation && params === this.params && !this.visibility.isHidden();
      if (shouldSchedule) {
        this.controller = null;
        this.timer = setTimeout(
          () => void this.poll(generation),
          Math.max(15, params.refreshSeconds) * 1_000,
        );
      }
    }
  }
}
