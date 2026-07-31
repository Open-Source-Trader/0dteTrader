# Testing and Observability

> Integration constraint: implement this capability through the existing Electron main, preload, lifecycle, build, packaging, and test patterns. Do not create parallel application infrastructure.

This file owns required test layers, failure injection, operational metrics, and logging limits.

## Test matrix

| Layer                    | Required coverage                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Pure domain              | Trigger policy, priority, replacement, dedupe, staleness, snapshot normalization, omission policy             |
| Protocol contracts       | Golden fixtures decoded by TypeScript and Swift; malformed lines; unknown messages; max size; invalid numbers |
| Transport                | Fragmented chunks; multiple lines per chunk; partial line; backpressure; stderr noise; child exit             |
| Supervisor               | Handshake timeout; version mismatch; legitimate unavailability; crash loop; graceful shutdown                 |
| Swift                    | Availability mapping; budgeter; omission declarations; structured output validation; cancellation             |
| Main-process integration | Fake shim executable; request routing; deadlines; owner window destruction; stale response                    |
| Real native smoke        | Supported macOS Foundation Models path                                                                        |
| Packaging                | Binary exists; executable; signed; correct architecture; starts from packaged location                        |
| Security architecture    | Forbidden imports; no generic bridge; no AI-to-order dependency; sanitized environment                        |
| Failure injection        | Hung model; malformed stdout; oversized event; duplicate terminal; sequence reversal; crash mid-stream        |
| Regression fixtures      | PR #54 overflow, gaps, ambiguous keys, omitted data, stale position versions                                  |

## Fake shim

Build a deterministic fake executable used by Electron main tests. It should support scripted behaviors:

- valid handshake and completion;
- streaming events;
- delayed response;
- cancellation;
- malformed JSON;
- oversized line;
- duplicate terminal event;
- out-of-order sequence;
- stderr output;
- immediate exit;
- crash mid-stream;
- ignored shutdown;
- incompatible version.

Do not mock only `AppleIntelligenceClient`; test actual child-process framing and lifecycle behavior.

## Required metrics

| Metric or event                      | Purpose                                                |
| ------------------------------------ | ------------------------------------------------------ |
| `shim_start_duration_ms`             | Detect startup or packaging regressions                |
| `handshake_result`                   | Diagnose compatibility and capability                  |
| `availability_state` and safe reason | Understand feature gating                              |
| `analysis_queue_wait_ms`             | Detect blocked single-flight work or trigger volume    |
| `analysis_duration_ms`               | Track latency by trigger kind                          |
| `analysis_terminal_state`            | Completed, cancelled, failed, timeout, stale-discarded |
| `snapshot_bytes` and `prompt_chars`  | Track budget regressions without content               |
| `omission_codes`                     | Understand degraded input categories                   |
| `shim_exit_code` and signal          | Diagnose crashes                                       |
| `protocol_violation_code`            | Detect malformed or incompatible behavior              |

## Logging constraints

Production telemetry must not record:

- prompts;
- raw snapshots;
- full model output;
- account identifiers;
- exact positions;
- order details;
- credentials;
- unrelated portfolio state.

## Deterministic CI checks

- Native binary exists in packaged artifact.
- TypeScript and Swift protocol fixtures agree.
- Architecture import boundaries pass.
- No generic preload bridge exists.
- Documentation links resolve.
- Version changes update canonical documents.
- Log-safety tests prove sample sensitive payloads do not appear in emitted logs.
