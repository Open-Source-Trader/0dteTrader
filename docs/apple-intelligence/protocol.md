# Electron-to-Swift Protocol

> Integration constraint: implement this capability through the existing Electron main, preload, lifecycle, build, packaging, and test patterns. Do not create parallel application infrastructure.

This file is the canonical owner of native wire framing, messages, errors, limits, and compatibility.

## Transport

Use newline-delimited JSON over child-process stdin/stdout.

- One UTF-8 JSON object per line.
- Stdout is protocol-only.
- Stderr is diagnostics-only.
- The parser must support fragmented chunks, multiple lines in one chunk, and a final partial buffer.
- Reject malformed JSON, embedded line framing abuse, oversized lines, and invalid numeric values.
- Apply explicit byte limits before unbounded allocation.

## Request envelope

```typescript
interface NativeRequest<TPayload> {
  protocolVersion: 1;
  requestId: string;
  method:
    | 'runtime.hello'
    | 'runtime.availability'
    | 'runtime.prewarm'
    | 'analysis.run'
    | 'analysis.cancel'
    | 'runtime.shutdown';
  deadlineAt?: string;
  payload: TPayload;
}
```

## Event envelope

```typescript
interface NativeEvent<TPayload = unknown> {
  protocolVersion: 1;
  requestId: string;
  event: 'ready' | 'accepted' | 'progress' | 'partial' | 'completed' | 'cancelled' | 'failed';
  sequence?: number;
  payload?: TPayload;
  error?: NativeError;
}
```

## Handshake

The sidecar must emit or respond with a `ready` event within a bounded startup timeout.

```typescript
interface RuntimeReadyPayload {
  shimVersion: string;
  supportedProtocolVersions: number[];
  snapshotSchemaVersions: number[];
  resultSchemaVersions: number[];
  capabilities: Array<
    'availability' | 'prewarm' | 'streaming' | 'structured-generation' | 'cancellation'
  >;
}
```

Electron main validates compatibility before accepting analysis work. Unsupported compatibility is an `incompatible` runtime state, not a restart loop.

## Protocol invariants

- Every non-runtime event matches an active request ID.
- Exactly one terminal event is permitted: `completed`, `cancelled`, or `failed`.
- Streaming events use monotonically increasing sequence numbers.
- Duplicate or decreasing sequence numbers are ignored and recorded as protocol violations.
- Unknown methods and events are rejected.
- Additive unknown fields may be ignored within a compatible protocol version.
- Main owns deadlines. The native request includes a deadline for cooperative cancellation.
- ISO-8601 UTC timestamps are used for wire identity.
- Exchange timezone is retained separately when semantically relevant.
- Reject `NaN`, `Infinity`, and unsafe number representations.
- Use explicit nullable fields rather than magic sentinel values.

## Renderer-to-main IPC

The renderer protocol is deliberately not the native protocol.

```typescript
interface AppleIntelligenceBridge {
  getAvailability(): Promise<AIAvailability>;
  prewarm(): Promise<void>;
  analyze(request: AnalyzeRequest): Promise<{ requestId: string }>;
  cancel(requestId: string): Promise<void>;
  subscribe(listener: (event: AnalysisEvent) => void): () => void;
}
```

Prohibited:

```typescript
window.native.invoke(method, payload);
window.electron.ipcRenderer;
```

Electron main runtime-validates renderer payloads before translating them into native requests.

## Errors

Errors must use stable machine-readable codes plus bounded safe detail.

Suggested categories:

```text
runtime_unavailable
runtime_incompatible
native_process_exited
handshake_timeout
request_timeout
request_cancelled
payload_invalid
payload_too_large
protocol_malformed_json
protocol_unknown_method
protocol_unknown_event
protocol_sequence_violation
protocol_duplicate_terminal
context_budget_exceeded
structured_output_invalid
model_guardrail_rejection
model_runtime_failure
```

Do not include raw prompts, snapshots, positions, model output, or secrets in error detail.

## Backpressure

The transport must respect child stdin backpressure. Queue writes until the stream drains. Do not continue allocating request buffers while the native process cannot accept data.

The analysis scheduler, not the transport, decides which work may be dropped or replaced.
