# Feature Scope and Existing-System Boundaries

This file owns the boundary between the Apple Intelligence feature and the existing 0dteTrader applications and domains.

## Existing desktop application

The Electron desktop application already exists. The feature implementation must preserve its current:

- application bootstrap and shutdown flow;
- BrowserWindow ownership;
- preload and `contextBridge` pattern;
- renderer architecture and workspace layout;
- `TradeStore`, `ChainStore`, and other authoritative state owners;
- API client and market-data subscriptions;
- position, order, broker, and risk behavior;
- build, packaging, signing, and release conventions.

The implementation may add narrow feature integration points. It must not replace or broadly reorganize those systems.

## Feature ownership

The Apple Intelligence feature owns:

- feature availability state;
- manual and automatic analysis trigger policy;
- immutable analysis snapshot construction;
- request scheduling, cancellation, deadlines, and staleness policy;
- Electron-to-Swift transport and native process supervision;
- platform-specific prompt assembly and context budgeting;
- constrained advisory result validation;
- feature-specific presentation state and telemetry.

## Existing-domain ownership

Existing deterministic application code continues to own:

- raw market and options data;
- candle construction;
- indicators and market structure calculations;
- candidate support/resistance and wall calculations;
- selected symbol, expiry, contract, and timeframe;
- current positions and orders;
- strategy rules and risk constraints;
- broker connectivity and execution;
- executable order state.

The feature consumes read-only representations of these facts. It does not become their source of truth.

## iOS relationship

PR #54 provides useful semantic vocabulary and context-budgeting lessons for on-demand iOS analysis. Desktop may reuse normalized analysis concepts, but must not copy iOS prompt text, modal interaction behavior, or platform runtime code.

Reusable concepts include:

- candle and indicator facts;
- options and chain facts;
- positions and orders as bounded analysis inputs;
- strict input budgets;
- explicit prioritization and degradation;
- declared omissions;
- lossless, interpretable candle representation.

Desktop uniquely owns automatic trigger policy, scheduling, staleness, Electron/native lifecycle, and persistent feature presentation.

## Shared package boundary

Platform-neutral snapshot or result semantics may live in an existing shared package when both platforms genuinely consume them. Shared packages must not own:

- generated prompt strings;
- Foundation Models types;
- Electron IPC envelopes;
- Swift process lifecycle;
- desktop feature state;
- order-execution behavior.

Do not create a shared abstraction speculatively. Extract one only after confirming actual cross-platform use and current repository conventions.

## Advisory-only boundary

The model may rank, interpret, summarize, and compare supplied evidence. It may not:

- calculate authoritative indicators;
- invent strategy policy;
- mutate positions, orders, risk limits, or stores;
- construct, submit, modify, or cancel an order;
- suppress deterministic warnings;
- create an execution callback path.

Any future movement across this boundary requires an explicit architecture decision and separate review.
