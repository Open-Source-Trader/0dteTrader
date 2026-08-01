// Electron main's authoritative request-lifecycle registry. Canonical spec:
// docs/apple-intelligence/lifecycle-and-concurrency.md ("Request ownership" —
// the `PendingRequest` registry) and protocol.md ("Main owns deadlines...
// Exactly one terminal event is permitted"). This module is the main-process
// implementation of that ownership; it sits between main.cjs's IPC handlers
// and NativeProcessSupervisor and does not itself talk to the child process.
//
// Responsibilities (lifecycle-and-concurrency.md "Request ownership"):
//   - generate/validate unique request IDs (reject duplicate active IDs);
//   - route native events only to the originating webContents;
//   - cancel requests when the owning window is destroyed;
//   - reject events for unknown requests (log, don't throw);
//   - enforce exactly one terminal event per request, even under races
//     (SequenceGuard already proves this per-line; this module additionally
//     guards the timeout-vs-late-completion race, which SequenceGuard alone
//     cannot see because a timeout is not a native protocol line);
//   - apply a bounded deadline and send cooperative cancellation on expiry;
//   - remove terminal requests deterministically.
//
// This is an additional layer on top of the supervisor's existing
// single-flight `state !== 'ready'` guard (Phase 1), not a replacement for it.
const { emitTelemetryEvent } = require('./telemetry.cjs');

const TERMINAL_EVENTS = new Set(['completed', 'cancelled', 'failed']);

// No existing repository constant covers an end-to-end analysis deadline
// (HANDSHAKE_TIMEOUT_MS/SHUTDOWN_GRACE_MS in supervisor.cjs cover process
// startup/shutdown, not inference latency). 30s is a conservative bound for
// single-flight on-device structured generation; chosen deliberately small
// enough to keep a hung request from blocking the single-flight slot for an
// unbounded time, per protocol.md ("Main owns deadlines").
const DEFAULT_DEADLINE_MS = 30000;

// How long a terminal requestId is remembered purely to distinguish "this
// request already finished, ignore the duplicate" from "this requestId was
// never seen" in handleNativeEvent's unknown-request logging path. Small and
// bounded — this is not the source of truth for size()/has(), which must
// reflect only active requests (no leak).
const TERMINAL_MEMORY_MS = 5000;

/**
 * @typedef {Object} PendingAnalysisRequest
 * @property {string} requestId
 * @property {number} originatingWebContentsId
 * @property {string} deadlineAt - ISO-8601 UTC, sent to Swift for cooperative cancellation
 * @property {boolean} terminal
 * @property {unknown} timeoutHandle
 */

/**
 * Owns the map of in-flight analysis requests. Pure with respect to the
 * child process: it never talks to `child_process` directly. The caller
 * (main.cjs) supplies a `send` function (typically `supervisor.send`) used
 * to deliver the cooperative `analysis.cancel` on timeout, and a `dispatch`
 * function used to route a terminal/native event to exactly the originating
 * `webContents`.
 */
class RequestRegistry {
  constructor({ send, dispatch, deadlineMs = DEFAULT_DEADLINE_MS, now = () => Date.now() } = {}) {
    this.send = send;
    this.dispatch = dispatch;
    this.deadlineMs = deadlineMs;
    this.now = now;
    /** @type {Map<string, PendingAnalysisRequest>} — active (non-terminal) requests only. */
    this.pending = new Map();
    /** @type {Map<string, unknown>} requestId -> forget timer, for recently-terminal duplicate detection. */
    this.recentlyTerminal = new Map();
  }

  get size() {
    return this.pending.size;
  }

  has(requestId) {
    return this.pending.has(requestId);
  }

  /** Whether `requestId` is currently active and owned by `webContentsId` —
   * used to authorize the explicit cancel IPC path so one window cannot
   * cancel another window's request. */
  isOwnedBy(requestId, webContentsId) {
    const entry = this.pending.get(requestId);
    return Boolean(entry) && !entry.terminal && entry.originatingWebContentsId === webContentsId;
  }

  /**
   * Registers a new request. Throws if `requestId` already has an active
   * (non-terminal) entry — duplicate active request IDs are rejected rather
   * than silently replacing the tracked owner, per lifecycle-and-concurrency.md.
   */
  register({ requestId, originatingWebContentsId, triggerKind }) {
    const existing = this.pending.get(requestId);
    if (existing && !existing.terminal) {
      throw new Error(`apple-intelligence: duplicate active requestId "${requestId}"`);
    }

    const deadlineAt = new Date(this.now() + this.deadlineMs).toISOString();
    /** @type {PendingAnalysisRequest} */
    const entry = {
      requestId,
      originatingWebContentsId,
      deadlineAt,
      terminal: false,
      registeredAt: this.now(),
      acceptedAt: null,
      // Metadata only (docs/apple-intelligence/testing-and-observability.md
      // "analysis_trigger_kind") — a short enum tag ('manual',
      // 'candle-close', 'position-critical', 'background'), never the
      // free-form `trigger.reason` string that accompanies it on the wire.
      triggerKind: typeof triggerKind === 'string' ? triggerKind : undefined,
      timeoutHandle: setTimeout(() => this.handleTimeout(requestId), this.deadlineMs),
    };
    this.pending.set(requestId, entry);
    return entry;
  }

  /**
   * Handles one decoded native event (already schema-validated and
   * sequence-guarded upstream). Routes to the originating webContents only,
   * enforces the terminal-once invariant, and removes the entry once a
   * terminal event is delivered. Unknown request IDs are ignored (logged by
   * the caller if desired) rather than thrown.
   */
  handleNativeEvent(event) {
    const entry = this.pending.get(event.requestId);
    if (!entry) {
      // Distinguish "already finished, this is a late duplicate" (ignore
      // quietly, do not revive) from "never registered" (unknown request —
      // caller may want to log this one as a protocol anomaly).
      if (this.recentlyTerminal.has(event.requestId)) {
        return { routed: false, reason: 'already-terminal' };
      }
      return { routed: false, reason: 'unknown-request' };
    }

    // `accepted` is Swift's earliest acknowledgement that single-flight work
    // began — the gap since `register()` is queue/dispatch wait, not
    // inference time.
    if (event.event === 'accepted' && entry.acceptedAt === null) {
      entry.acceptedAt = this.now();
      emitTelemetryEvent('analysis_queue_wait', {
        requestId: entry.requestId,
        analysisQueueWaitMs: entry.acceptedAt - entry.registeredAt,
        analysisTriggerKind: entry.triggerKind,
      });
    }

    const isTerminal = TERMINAL_EVENTS.has(event.event);
    if (isTerminal) {
      emitTelemetryEvent('analysis_terminal', {
        requestId: entry.requestId,
        analysisTerminalState: event.event,
        analysisDurationMs: this.now() - entry.registeredAt,
        analysisTriggerKind: entry.triggerKind,
        errorCode: event.error?.code,
      });
      this.markTerminal(entry);
    }
    this.dispatch?.(entry.originatingWebContentsId, event);
    return { routed: true, terminal: isTerminal };
  }

  /** Deadline expired: send cooperative cancellation to Swift and deliver a
   * synthetic `failed`/request_timeout terminal event to the owner — main
   * does not wait for Swift to acknowledge; the timer itself is what
   * terminates the request from the app's perspective. */
  handleTimeout(requestId) {
    const entry = this.pending.get(requestId);
    if (!entry) return;

    this.send?.({
      protocolVersion: 1,
      requestId,
      method: 'analysis.cancel',
      payload: {},
    });

    emitTelemetryEvent('analysis_terminal', {
      requestId: entry.requestId,
      analysisTerminalState: 'failed',
      analysisDurationMs: this.now() - entry.registeredAt,
      analysisTriggerKind: entry.triggerKind,
      errorCode: 'request_timeout',
    });
    this.markTerminal(entry);
    this.dispatch?.(entry.originatingWebContentsId, {
      protocolVersion: 1,
      requestId,
      event: 'failed',
      error: { code: 'request_timeout', message: 'Analysis exceeded its deadline.' },
    });
  }

  /** Cancels every request owned by a destroyed webContents. Delivers a
   * `cancelled` terminal event locally (the renderer that owned it is gone,
   * so nothing actually needs to receive it, but bookkeeping still applies)
   * and sends cooperative cancellation to Swift. */
  cancelForWebContents(webContentsId) {
    for (const entry of [...this.pending.values()]) {
      if (entry.originatingWebContentsId !== webContentsId) continue;
      this.send?.({
        protocolVersion: 1,
        requestId: entry.requestId,
        method: 'analysis.cancel',
        payload: {},
      });
      emitTelemetryEvent('analysis_terminal', {
        requestId: entry.requestId,
        analysisTerminalState: 'cancelled',
        analysisDurationMs: this.now() - entry.registeredAt,
        analysisTriggerKind: entry.triggerKind,
      });
      this.markTerminal(entry);
    }
  }

  /** Sidecar exited: every pending request is unreachable. Reject all of
   * them deterministically (lifecycle-and-concurrency.md "Crashed: Reject
   * all pending requests deterministically"). No cancel is sent — the child
   * that would receive it is already gone. */
  rejectAll(reason = 'native_process_exited') {
    for (const entry of [...this.pending.values()]) {
      emitTelemetryEvent('analysis_terminal', {
        requestId: entry.requestId,
        analysisTerminalState: 'failed',
        analysisDurationMs: this.now() - entry.registeredAt,
        analysisTriggerKind: entry.triggerKind,
        errorCode: reason,
      });
      this.markTerminal(entry);
      this.dispatch?.(entry.originatingWebContentsId, {
        protocolVersion: 1,
        requestId: entry.requestId,
        event: 'failed',
        error: { code: reason, message: 'The native process exited.' },
      });
    }
  }

  /** App shutdown: clear every timer without dispatching further events —
   * there is no renderer left to receive them and no child process left to
   * cancel against. Prevents orphaned timers from firing post-shutdown. */
  clear() {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeoutHandle);
    }
    this.pending.clear();
    for (const forgetTimer of this.recentlyTerminal.values()) {
      clearTimeout(forgetTimer);
    }
    this.recentlyTerminal.clear();
  }

  markTerminal(entry) {
    entry.terminal = true;
    clearTimeout(entry.timeoutHandle);
    this.pending.delete(entry.requestId);

    // Remember briefly so a late duplicate is recognized as "already
    // terminal" rather than misreported as a completely unknown requestId.
    const forgetTimer = setTimeout(() => this.recentlyTerminal.delete(entry.requestId), TERMINAL_MEMORY_MS);
    forgetTimer.unref?.();
    this.recentlyTerminal.set(entry.requestId, forgetTimer);
  }
}

module.exports = { RequestRegistry, DEFAULT_DEADLINE_MS, TERMINAL_EVENTS };
