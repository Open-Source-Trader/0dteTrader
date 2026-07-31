# Lifecycle, Concurrency, and Staleness

> Integration constraint: implement this capability through the existing Electron main, preload, lifecycle, build, packaging, and test patterns. Do not create parallel application infrastructure.

This file owns runtime state, request scheduling, cancellation, staleness, and restart behavior.

## Runtime state machine

```text
stopped
  -> starting
  -> handshaking
  -> ready | unavailable | incompatible
  -> degraded
  -> crashed
  -> restarting | disabled
```

## State behavior

| State or transition | Required behavior                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Starting            | Resolve fixed binary path, validate executable, spawn with sanitized environment and fixed working directory |
| Handshaking         | Require compatible `ready` response within timeout before accepting analysis                                 |
| Unavailable         | Surface reason; do not restart when Foundation Models is legitimately unavailable                            |
| Incompatible        | Disable analysis for the session; expose version mismatch; do not restart-loop                               |
| Degraded            | Suspend automatic analysis after repeated timeouts/model failures; permit manual retry                       |
| Crashed             | Reject all pending requests deterministically and record one safe diagnostic                                 |
| Shutdown            | Stop accepting work, cancel active task, request graceful shutdown, then terminate after bounded timeout     |

## Long-lived process, short-lived sessions

Keep one sidecar process alive for the existing desktop application session and attach its startup/shutdown to current Electron lifecycle hooks. Create fresh Foundation Models sessions per analysis in v1.

Do not retain a day-long transcript. Model process lifetime and model conversation lifetime are different concerns.

## Single-flight scheduler

Run one inference at a time initially.

Priority order:

1. Position-critical
2. Manual
3. Candle-close
4. Background

Rules:

- Position-critical work may preempt candle-close or background work.
- Manual work may preempt background work but must not silently override active position-critical analysis.
- A newer candle-close request replaces an older queued candle-close request for the same symbol and timeframe.
- Deduplicate identical snapshot hashes.
- Bound the queue.
- Drop stale background work instead of accumulating latency.
- Cancel active work when its result cannot affect the current view.
- Work allowed to finish for history must still pass the staleness gate before promotion.

## Request ownership

Electron main owns a request registry containing at least:

```typescript
interface PendingRequest {
  requestId: string;
  rendererWebContentsId: number;
  startedAt: number;
  deadlineAt: number;
  status: 'queued' | 'pending' | 'streaming';
  context: AnalysisContextIdentity;
}
```

The registry must:

- generate or validate unique request IDs;
- route events only to the originating `webContents`;
- cancel requests when the owning window is destroyed;
- reject events for unknown requests;
- enforce one terminal state;
- apply deadlines;
- remove terminal requests deterministically.

The Swift process does not know which renderer owns a request.

## Cancellation

Cancellation is cooperative through every layer:

```text
renderer
  -> Electron main IPC
  -> scheduler/request registry
  -> analysis.cancel native request
  -> Swift task cancellation
  -> Foundation Models cancellation
  -> cancelled terminal event
```

Cancellation is not an error and must not be counted as model failure.

## Staleness gate

A result may update current guidance only when its immutable context still matches current authoritative state:

- symbol;
- timeframe;
- snapshot sequence;
- position version;
- strategy-policy version;
- relevant selected-contract identity.

A stale result may be retained for local diagnostics or history. It must never replace current guidance.

## Crash-loop policy

| Event                                  | Response                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| First unexpected exit                  | Reject pending requests and restart once immediately                            |
| Second exit within 60 seconds          | Restart after short backoff                                                     |
| Third exit within 60 seconds           | Use longer backoff and suspend automatic analysis                               |
| Fourth exit or repeated protocol fault | Disable restart for the session; expose manual restart and safe diagnostic code |
| Normal application shutdown            | Do not restart                                                                  |

Backoff timing should be centralized and testable. Do not scatter restart timers across feature code.

## Automatic trigger boundary

Do not implement automatic candle or position triggers until:

- manual analysis works end to end;
- protocol validation is complete;
- cancellation works;
- staleness is tested;
- crash recovery is tested;
- structured result validation is enforced.
