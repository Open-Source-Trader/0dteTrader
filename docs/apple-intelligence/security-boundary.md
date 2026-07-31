# Security and Privacy Boundary

This file owns the threat model, denied capabilities, IPC validation requirements, data minimization, and logging restrictions.

## Trust model

Treat the renderer as less trusted than Electron main. Treat every native process line as untrusted input until parsed and validated. Treat model output as untrusted advisory data until schema and grounding validation pass.

## Explicitly denied sidecar capabilities

The Swift target must not receive or implement:

- brokerage or API credentials;
- account identifiers not required for analysis;
- order placement, modification, cancellation, or position sizing;
- network requests;
- keychain access;
- shell execution;
- arbitrary filesystem reads;
- dynamic plugin loading;
- direct renderer or Electron access;
- callbacks into broker or order APIs.

## Threat controls

| Threat                                     | Control                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Renderer invokes arbitrary native behavior | Named preload methods only; no generic invoke; runtime validation in main                       |
| Protocol injection                         | Central serializer; one JSON object per line; strict byte limits and parser                     |
| Child inherits credentials                 | Spawn with minimal allowlisted environment; never forward `process.env` wholesale               |
| Native dependency introduces networking    | Dependency/import review and CI boundary check                                                  |
| Sensitive values enter logs                | Metadata-only logs; prompts, snapshots, positions, orders, and model output excluded by default |
| Model output controls execution            | No AI-to-order import path or callback; existing deterministic user action remains required     |
| Prompt injection from external text        | No external news/web text in v1; future external content treated strictly as data               |
| Oversized input causes memory pressure     | Byte caps at renderer IPC, main transport, and Swift decoder                                    |
| Binary tampering                           | Fixed path inside signed bundle; reject unexpected writable path or architecture mismatch       |
| Cross-window leakage                       | Track originating `webContents`; route only to owner; cancel on destruction                     |
| AI unavailable causes core failure         | Capability gate and unavailable provider; no spawn loop                                         |
| Confidence appears calibrated              | Label as model-reported interpretation and display omissions/freshness                          |

## Spawn environment

Construct an allowlisted environment required only for runtime operation. Do not inherit the entire parent environment.

Set a fixed working directory which contains no sensitive data and is not used as a general storage area.

## Data minimization

Snapshots should include only data required for the requested analysis. Exclude:

- unrelated symbols or positions;
- account numbers;
- customer or user identity;
- authentication state;
- hidden application configuration;
- raw environment variables;
- order history unrelated to current context.

## Logging

Stdout from the shim is protocol-only.

Stderr and application telemetry may record:

- request ID;
- trigger category;
- duration;
- byte counts;
- omission codes;
- terminal state;
- safe error code;
- shim version and protocol version.

They must not record raw snapshots, prompts, full generated output, exact positions, order details, credentials, or account identifiers by default.

Development debug capture must be explicit, local, visibly enabled, excluded from production builds where practical, and easy to purge.

## Advisory-only enforcement

The AI result may update an analysis panel or annotation state. It cannot:

- submit an order;
- populate an executable order without explicit existing user action and deterministic validation;
- change risk limits;
- alter authoritative indicators;
- mutate current position state;
- suppress broker or strategy warnings.
