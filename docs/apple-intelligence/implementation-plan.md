# Feature Implementation Plan

Each phase should be a reviewable pull request or tightly bounded series. The existing Electron application is the host. Do not combine broad desktop refactoring with this feature.

## Phase 0: Repository integration map and contracts

Deliver:

- commit this documentation hierarchy under `docs/apple-intelligence/`;
- inspect and document the existing Electron main, preload, renderer, lifecycle, build, packaging, and test integration points;
- select exact feature-owned implementation paths consistent with current conventions;
- define protocol and semantic schemas with runtime validation ownership;
- add architecture-boundary test skeletons;
- define the deterministic fake-shim behavior plan.

Do not create a second Electron bootstrap, preload root, application store, or packaging pipeline. Do not invoke Foundation Models yet.

Exit criteria:

- all documentation links resolve;
- the implementation map names existing extension points instead of hypothetical replacement infrastructure;
- TypeScript protocol fixtures exist;
- forbidden dependency rules have executable test skeletons;
- no unrelated desktop architecture change is included.

## Phase 1: Native bridge proof through existing Electron lifecycle

Deliver:

- feature-owned long-lived Swift executable;
- `runtime.hello` or ready handshake;
- availability;
- prewarm;
- analyze using a fixed bounded test payload;
- cancellation;
- graceful shutdown;
- feature service registered through the existing Electron main lifecycle;
- narrow additions to the existing preload bridge;
- fake-shim integration tests using actual child-process framing.

Do not add automatic triggers, position integration, workspace redesign, or replacement application services.

## Phase 2: Structured model adapter

Deliver:

- constrained result schema;
- structured-output validation;
- deterministic context budgeter;
- omission metadata;
- Swift unit tests;
- stable error mapping;
- grounding rejection for generated numeric levels.

## Phase 3: Manual feature integration

Deliver:

- snapshot builder consuming existing authoritative read models or selectors;
- typed renderer provider using the current preload pattern;
- request registry and deadlines;
- staleness gate;
- minimal manual invocation integrated into the existing workspace;
- unsupported and unavailable runtime behavior.

Preserve current stores, charting, order behavior, workspace layout rules, and application lifecycle.

## Phase 4: Automatic completed-candle analysis

Deliver:

- pure trigger policy for completed candles;
- bounded single-flight scheduler;
- replacement and deduplication;
- feature presentation state for latest and historical analysis;
- queue and latency metrics;
- stale-result history handling.

Do not trigger on every quote.

## Phase 5: Position lifecycle analysis

Deliver:

- position-open, scale, material-change, and close triggers;
- position-critical priority and preemption;
- position-version staleness gating;
- management-task evidence requirements;
- advisory-only presentation.

No order execution or automatic action.

## Phase 6: Packaging and release hardening

Deliver:

- integration with the existing native build and Electron packaging flow;
- deterministic packaged binary resolution;
- architecture verification;
- code signing and notarization;
- packaged smoke tests;
- crash-loop and degraded-mode verification;
- performance measurements on supported hardware;
- security review;
- production log-safety review.

## Agent workflow per phase

1. Read the relevant canonical feature documents.
2. Inspect current repository paths and conventions.
3. State existing host files and feature-owned files expected to change.
4. Identify any mismatch between documentation and current code.
5. Implement the smallest coherent feature slice.
6. Add deterministic success and failure tests.
7. Run repository verification commands.
8. Update canonical documentation only when established facts changed.
9. Report completed criteria, unresolved risks, and deliberate deferrals.
