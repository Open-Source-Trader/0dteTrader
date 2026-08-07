# ADR: Apple Intelligence Swift Sidecar

Status: Proposed - implementation baseline  
Date: July 31, 2026  
Decision owner: Principal architect

## Context

The existing desktop application runs in Electron. Apple Foundation Models is a native Swift framework and is not directly available to renderer JavaScript. The application requires responsive on-device analysis while preserving trading reliability, security, and clean process ownership.

The native integration must support:

- availability discovery;
- prewarming;
- structured generation;
- streaming;
- cancellation;
- bounded context assembly;
- independent failure and restart;
- packaged signing and notarization.

## Decision

Use one long-lived Swift executable as a sidecar process.

The existing Electron main process exclusively owns the feature process through a narrowly scoped service. It communicates with the sidecar through a versioned newline-delimited JSON protocol over stdin/stdout. Renderer code receives only narrow typed additions to the existing preload API.

Use single-flight inference and fresh short-lived Foundation Models sessions for v1.

## Rationale

The sidecar provides:

- straightforward Swift access to Foundation Models;
- crash isolation from Electron;
- stable Node/Electron compatibility without native addon ABI coupling;
- easy deterministic testing with a fake executable;
- simple streaming and cancellation;
- explicit signing and packaging ownership;
- a narrow capability surface.

NDJSON over stdio is sufficient for expected payload volume and simplifies debugging, framing, restart, and contract tests.

## Rejected initial alternatives

### Node native addon

Rejected because it adds Objective-C++/Swift interop, Electron ABI concerns, tighter crash coupling, and more complex builds without a demonstrated benefit.

### XPC service

Deferred because it adds entitlements, code-signing topology, lifecycle complexity, and debugging overhead. Reconsider only with measured evidence showing stdio cannot meet security, performance, or lifecycle requirements.

### Spawn per request

Rejected because repeated process and model startup increases latency and weakens lifecycle control.

### Renderer-owned process

Rejected because it exposes native capability to the least trusted application layer and prevents centralized routing, validation, and failure isolation.

### Cloud-only model provider

Outside this decision. A provider abstraction may permit a future fallback, but cloud inference does not replace the native boundary described here.

## Consequences

- Release tooling must build, sign, package, and notarize the Swift executable.
- Electron main must supervise the child process and validate the wire protocol.
- The feature must remain optional on unsupported systems and CI.
- The shim must remain deliberately narrow and cannot become a second application backend.
- Protocol, snapshot, result, and shim versions require independent compatibility handling.

## Amendment threshold

An ADR amendment is required before:

- replacing stdio with XPC or another transport;
- allowing multiple concurrent model inferences;
- permitting persistent multi-request model sessions;
- adding native network, keychain, shell, or arbitrary filesystem capability;
- allowing AI results to construct or invoke order execution;
- moving process ownership outside Electron main.
