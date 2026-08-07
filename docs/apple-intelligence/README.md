# Apple Intelligence Feature Architecture

Status: Proposed implementation baseline  
Date: July 31, 2026

This directory is the canonical documentation hierarchy for implementing Apple Intelligence as a **feature inside the existing 0dteTrader Electron desktop application**.

The Electron application, renderer, main process, preload bridge, packaging pipeline, stores, and trading workflows already exist. This design extends those systems. It does not authorize creation of a replacement desktop shell, a parallel Electron application, a new application bootstrap, or broad desktop refactoring.

## Two-minute orientation

Apple Intelligence runs in a signed Swift sidecar process owned by the existing Electron main process. Existing desktop state is transformed into immutable analysis snapshots. Foundation Models returns constrained advisory results through a narrow extension to the existing preload API.

```text
Existing renderer and stores
    -> Apple Intelligence feature coordinator and snapshot builder
Existing preload bridge
    -> explicit Apple Intelligence methods and events
Existing Electron main process
    -> feature-owned scheduler, transport, and sidecar supervisor
Signed Swift sidecar
    -> FoundationModels.framework
```

AI is never part of market-data ingestion, broker connectivity, risk enforcement, or order execution. The desktop application must remain fully usable when AI is unsupported, disabled, unavailable, incompatible, hung, or crashed.

## How the programming agent should use this hierarchy

1. Start with [`agent-prompt.md`](agent-prompt.md).
2. Read [`architecture.md`](architecture.md), [`scope-and-boundaries.md`](scope-and-boundaries.md), and [`adr-swift-sidecar.md`](adr-swift-sidecar.md).
3. Read only the documents relevant to the implementation phase.
4. Inspect the current repository before choosing exact paths or class names.
5. Extend existing Electron lifecycle, preload, build, packaging, and test infrastructure rather than duplicating them.
6. Link to canonical documents instead of copying architectural prose into task prompts.

## Read by task

| Task                                         | Read                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------- |
| Understand feature placement and ownership   | [`architecture.md`](architecture.md)                                 |
| Understand what may and may not change       | [`scope-and-boundaries.md`](scope-and-boundaries.md)                 |
| Review the sidecar decision and alternatives | [`adr-swift-sidecar.md`](adr-swift-sidecar.md)                       |
| Implement Electron/Swift messages            | [`protocol.md`](protocol.md)                                         |
| Implement snapshots or results               | [`data-contracts.md`](data-contracts.md)                             |
| Implement scheduling or cancellation         | [`lifecycle-and-concurrency.md`](lifecycle-and-concurrency.md)       |
| Build prompts or trim context                | [`context-and-prompt-budgeting.md`](context-and-prompt-budgeting.md) |
| Review permissions and threat boundaries     | [`security-boundary.md`](security-boundary.md)                       |
| Package the native executable                | [`packaging-and-signing.md`](packaging-and-signing.md)               |
| Add tests, logging, or metrics               | [`testing-and-observability.md`](testing-and-observability.md)       |
| Enforce dependency boundaries                | [`architecture-enforcement.md`](architecture-enforcement.md)         |
| Plan implementation phases                   | [`implementation-plan.md`](implementation-plan.md)                   |
| Verify completion                            | [`acceptance-criteria.md`](acceptance-criteria.md)                   |
| Avoid architectural traps                    | [`gotchas-and-boundaries.md`](gotchas-and-boundaries.md)             |

## Non-goals for v1

- Rebuilding or reorganizing the Electron application
- Replacing existing stores, charting, order, position, or broker modules
- Autonomous trading
- Tick-by-tick inference
- Model-derived indicator calculations
- Day-long conversational sessions
- Concurrent model sessions
- XPC
- Native tool calls into broker or desktop services
- External news or web prompt content
- Cloud fallback

## Source context

- [0dteTrader PR #54: iOS AI analysis and prompt compaction](https://github.com/Open-Source-Trader/0dteTrader/pull/54)
- [0dteTrader PR #80: existing desktop workspace architecture](https://github.com/Open-Source-Trader/0dteTrader/pull/80)
- [Documentation as a Hierarchy, Not a Pile](https://brianperry.dev/posts/2026/documentation-as-a-hierarchy/)
