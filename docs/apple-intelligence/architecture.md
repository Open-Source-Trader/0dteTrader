# Apple Intelligence Feature Architecture

This file owns feature process boundaries, component responsibilities, dependency direction, and integration with the existing Electron application.

## Architectural position

Apple Intelligence is an optional advisory feature adjacent to the authoritative trading system.

```text
Existing authoritative market and trade state
    -> feature-owned immutable analysis snapshot
    -> existing renderer-to-main boundary
    -> feature-owned Electron main service
    -> signed Swift sidecar
    -> Apple Foundation Models
    -> constrained advisory result
    -> feature presentation state
```

The feature does not own or replace the desktop application, application startup, BrowserWindow lifecycle, global preload design, market-data ingestion, stores, charting, brokerage services, position ownership, risk logic, or order execution.

## Integration rule

Extend existing infrastructure at the narrowest stable seams:

- register feature IPC handlers through the current main-process registration pattern;
- add explicit feature methods to the current preload bridge;
- use the current application lifecycle to start and stop the sidecar service;
- use the current packaging configuration to embed the Swift executable;
- consume existing read models or selectors instead of moving authoritative state into the feature;
- follow current repository naming, dependency injection, state-management, and test conventions.

Do not create a second Electron bootstrap, second preload entry point, second BrowserWindow owner, parallel global event bus, or replacement application store.

## Target component topology

Names and locations below are illustrative ownership boundaries. The agent must inspect current repository conventions before selecting exact implementation paths.

```text
Existing React renderer
  Existing authoritative stores/read models
          |
          +-- Apple Intelligence feature
              - AnalysisCoordinator
              - AnalysisTriggerPolicy
              - AnalysisSnapshotBuilder
              - AnalysisStore or feature state adapter
              - DesktopAIProvider
                    |
                    | explicit additions to existing contextBridge
                    v
Existing Electron main process
  Existing startup/shutdown and IPC registration
          |
          +-- Apple Intelligence feature service
              - AppleIntelligenceClient
              - AnalysisScheduler
              - NativeProtocolTransport
              - NativeProcessSupervisor
              - NativeBinaryResolver
                    |
                    | NDJSON over stdin/stdout
                    v
Feature-owned Swift sidecar
  - ProtocolDecoder / ProtocolEncoder
  - AvailabilityService
  - ModelRuntime
  - SessionRegistry
  - PromptAssembler
  - ContextBudgeter
  - FoundationModels.framework
```

## Renderer feature responsibilities

`AnalysisCoordinator` observes existing authoritative state transitions, evaluates trigger policy, requests immutable snapshots, submits or cancels work, and rejects stale results. It does not know how the child process works.

`AnalysisTriggerPolicy` is pure decision logic. It returns a trigger reason and priority for manual requests, completed candles, position changes, and material setup changes.

`AnalysisSnapshotBuilder` creates normalized facts with provenance, freshness, units, omission metadata, and budget priority. It reads existing domain state or selectors; it does not scrape the DOM or generate prompt prose.

`AnalysisStore` or the equivalent feature state adapter owns presentation state only. It cannot mutate authoritative trading state and cannot promote a result without the staleness gate.

`DesktopAIProvider` adapts the narrow preload surface to feature-domain events. It cannot expose generic IPC or native invocation.

## Electron main feature responsibilities

`AppleIntelligenceClient` is the feature facade for availability, prewarm, analyze, cancel, shutdown, and runtime state.

`AnalysisScheduler` owns single-flight queueing, priority, replacement, deduplication, deadlines, and stale-work cancellation.

`NativeProtocolTransport` owns NDJSON framing, incremental parsing, byte limits, request correlation, stream ordering, backpressure, and protocol violations.

`NativeProcessSupervisor` owns spawn, handshake, health, child exit, restart, crash-loop behavior, graceful shutdown, and sanitized stderr collection. It must attach to the existing application lifecycle rather than create a competing lifecycle manager.

`NativeBinaryResolver` owns development and packaged paths, executable checks, architecture validation, and fixed-path resolution using the existing packaging model.

## Swift sidecar responsibilities

The Swift sidecar owns Foundation Models integration only:

- availability mapping;
- stable instruction prewarming;
- fresh session creation;
- constrained generation;
- prompt assembly and deterministic context budgeting;
- cooperative cancellation;
- structured error mapping.

It does not understand Electron, UI state, broker execution, credentials, account identity, order construction, or application persistence.

## Dependency rules

| Rule                                                  | Required enforcement                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| Renderer cannot spawn native processes                | No renderer or preload `child_process` import                       |
| Renderer cannot address arbitrary IPC                 | Explicit additions to the existing preload contract only            |
| Existing main process owns one sidecar supervisor     | No feature-local process creation outside the approved main service |
| Snapshot builder reads domain state, not presentation | No chart screenshot or DOM scraping as primary input                |
| AI cannot mutate authoritative state                  | Advisory DTOs and feature presentation state only                   |
| AI cannot reach order execution                       | Forbidden imports and dependency tests                              |
| Swift cannot inherit secrets                          | Minimal allowlisted spawn environment                               |
| Swift cannot become an application backend            | No network, keychain, shell, arbitrary file, or plugin capability   |
| Prompt strings remain platform-specific               | Share semantics where useful, not rendered prompts                  |
| Existing Electron shell remains authoritative         | No new bootstrap, window owner, preload root, or application store  |

## Runtime abstraction

```typescript
interface DesktopAIProvider {
  getAvailability(): Promise<AIAvailability>;
  prewarm(): Promise<void>;
  analyze(request: AnalyzeRequest): Promise<{ requestId: string }>;
  cancel(requestId: string): Promise<void>;
  subscribe(listener: (event: AnalysisEvent) => void): () => void;
}
```

The interface is representative. Integrate with existing service patterns and runtime validators. It must not contain order-domain methods.

## Version ownership

Version independently:

```text
applicationVersion
shimVersion
protocolVersion
snapshotSchemaVersion
resultSchemaVersion
strategyPolicyVersion
```

The desktop application version is not a substitute for protocol or schema compatibility.
