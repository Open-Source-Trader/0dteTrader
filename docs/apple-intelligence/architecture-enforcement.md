# Architecture Enforcement

Architectural boundaries must be executable where practical. Documentation alone is insufficient.

## Required static controls

Add repository checks which prevent:

- renderer or preload code from importing `child_process`;
- renderer access to `ipcRenderer` outside the approved preload implementation;
- generic native invocation APIs;
- Apple Intelligence modules importing order placement, order mutation, broker credential, or broker execution modules;
- Swift shim dependencies which add networking, shell execution, keychain access, or dynamic plugin loading;
- native protocol logs on stdout;
- packaged builds which omit the feature-owned native executable;
- a second Electron bootstrap, preload entry point, BrowserWindow owner, or application-wide store created for this feature.

Use existing lint, dependency-graph, or test infrastructure where possible. Do not add a second toolchain solely for one rule when a current tool can enforce it.

## Runtime controls

Runtime validation is required at every trust boundary:

1. Renderer payload entering Electron main.
2. Native request before serialization.
3. Every NDJSON line entering Electron main.
4. Every NDJSON request entering Swift.
5. Structured model output before returning to Electron.
6. Advisory result before promotion to current UI state.

TypeScript types do not satisfy runtime validation.

## Contract fixtures

Maintain golden protocol fixtures decoded by both TypeScript and Swift tests. Fixtures must cover:

- supported messages;
- additive unknown fields;
- unknown methods and events;
- malformed JSON;
- oversized lines;
- invalid numbers;
- duplicate terminal events;
- out-of-order stream sequences;
- incompatible versions.

## Documentation checks

CI should verify:

- links from this feature index and phase documents resolve;
- protocol or schema version changes update the canonical protocol/data documents;
- no second file claims canonical ownership of the same boundary;
- Phase acceptance criteria are updated when implementation facts change.

## Review rule

A pull request changing a foundational boundary must include an ADR amendment. A code-only boundary change is incomplete.
