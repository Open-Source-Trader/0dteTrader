# Programming Agent Prompt

You are the assisting engineer implementing Apple Intelligence as a feature within the existing 0dteTrader Electron desktop application.

## Read first

Read, in order:

1. `/docs/apple-intelligence/README.md`
2. `/docs/apple-intelligence/architecture.md`
3. `/docs/apple-intelligence/scope-and-boundaries.md`
4. `/docs/apple-intelligence/adr-swift-sidecar.md`
5. `/docs/apple-intelligence/architecture-enforcement.md`
6. `/docs/apple-intelligence/implementation-plan.md`
7. Every phase-specific document linked from the feature index.
8. Existing repository-level and nearest-scope `AGENTS.md` or equivalent guidance already present in the repository.

## Core framing

The Electron desktop application already exists. This is a bounded feature implementation.

Do not create or replace:

- the Electron application bootstrap;
- BrowserWindow ownership;
- the root preload entry point;
- the application-wide store architecture;
- market-data, position, order, broker, or risk systems;
- the packaging or release pipeline;
- the desktop workspace architecture.

Extend current seams and conventions. Create feature-owned modules only where no suitable existing abstraction exists.

## Architectural authority

The ADR and feature documents in this directory are canonical.

Do not alter process ownership, native transport, single-flight policy, security restrictions, structured-output requirement, staleness gate, or advisory-only execution boundary without stopping and proposing an ADR amendment.

Do not copy architectural prose into another task plan. Link to its canonical file.

## Implementation posture

- Inspect the current repository and PR #80-derived desktop structure before selecting paths.
- Identify the existing main-process startup/shutdown, IPC registration, preload exposure, renderer state, packaging, signing, and test extension points.
- Preserve existing `TradeStore`, `ChainStore`, API client, position, order, broker, and risk behavior.
- Treat interface names and paths in these documents as ownership guidance; conform exact names to current repository conventions.
- Keep renderer code unaware of child processes, binary paths, and native wire messages.
- Keep Swift unaware of Electron, credentials, broker APIs, UI state, order execution, and application persistence.
- Runtime-validate renderer IPC, NDJSON, and structured model output.
- Use one long-lived sidecar process and one inference at a time in v1.
- Use fresh short-lived Foundation Models sessions.
- Never parse prose into trading actions.
- Never accept an ungrounded generated numeric level.
- Do not implement automatic candle or position triggers before the manual structured path, cancellation, staleness, and failure tests pass.
- Do not add unrelated desktop refactoring or UI redesign.

## Required first step

Before implementation, produce a concise repository integration map containing:

- current Electron main entry and lifecycle hooks;
- current preload bridge and IPC registration pattern;
- current renderer feature/state conventions;
- current build, package, sign, and notarization configuration;
- current tests suitable for child-process integration and boundary checks;
- proposed feature-owned files;
- existing host files requiring narrow modification;
- conflicts between current code and these architecture documents.

Do not propose a replacement architecture merely because an illustrative name or path differs from the repository.

## Required workflow

For each phase:

1. State the phase and canonical documents read.
2. List existing host files and new feature files expected to change.
3. Explain each host-file change as a narrow integration point.
4. Identify architectural mismatches before coding.
5. Implement the smallest coherent phase.
6. Add deterministic success and failure tests.
7. Run repository verification commands.
8. Update canonical documents only when implementation changed established facts.
9. Report completed acceptance criteria, unresolved risks, and deliberate deferrals.

## Begin with Phase 0

Do not invoke Foundation Models until Phase 0 is complete:

- documentation is present under `/docs/apple-intelligence/`;
- existing Electron integration points are mapped;
- exact feature ownership and host modifications are identified;
- protocol and semantic contracts exist;
- runtime validation ownership is defined;
- architecture-boundary test skeletons exist;
- fake-shim behavior is specified;
- all feature-document links resolve.

After Phase 0, present the implementation map and verification evidence before proceeding to Phase 1.

## Review checklist

Before reporting a phase complete, verify:

- the existing Electron application was extended rather than duplicated;
- no new application bootstrap, preload root, or global store was introduced;
- canonical ownership was preserved;
- current paths were inspected rather than assumed;
- AI remains advisory and outside execution;
- cancellation, malformed protocol, child failure, and staleness are tested where applicable;
- verification command output is included;
- unrelated refactoring was avoided.
