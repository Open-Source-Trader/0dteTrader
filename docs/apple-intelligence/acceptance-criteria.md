# Acceptance Criteria

> Integration constraint: implement this capability through the existing Electron main, preload, lifecycle, build, packaging, and test patterns. Do not create parallel application infrastructure.

The foundation is complete only when all applicable criteria pass.

## Functional isolation

- The existing desktop application launches and trades normally when the shim is absent, unsupported, unavailable, disabled, incompatible, hung, or crashed.
- One feature-owned native process, supervised by the existing Electron main lifecycle, serves multiple analyses.
- Normal request failure does not restart the entire application.
- Cancellation and shutdown are bounded.

## Security and dependency boundaries

- Renderer cannot spawn or resolve the native executable.
- Renderer has no generic IPC/native API.
- The sidecar receives no credentials and has no broker, network, keychain, shell, arbitrary file, or plugin capability.
- AI modules cannot import order execution modules.
- Model output cannot invoke or mutate execution state.

## Protocol and lifecycle

- Every request has an ID, deadline, and immutable snapshot identity.
- Every request receives exactly one terminal event.
- Protocol byte limits and malformed-message handling are tested.
- Stream sequence ordering is enforced.
- Request events route only to the owning renderer window.
- The supervisor handles handshake timeout, incompatibility, child exit, crash loop, and graceful shutdown.

## Scheduling and staleness

- Automatic analysis is single-flight, bounded, deduplicated, and replaceable.
- Position-critical work can preempt lower-priority work.
- Older candles cannot overwrite newer state.
- Results for changed positions or policy versions cannot become current guidance.

## Context and result safety

- Budget-driven omissions are explicit in model input and result metadata.
- Required position/risk evidence cannot be silently omitted from management tasks.
- Every structured numeric level references supplied evidence or a deterministic rule ID.
- Ungrounded levels are rejected or downgraded to observation-only output.
- Prose is never parsed into an action.

## Packaging and release

- Packaged application contains the expected native executable.
- The executable is runnable, signed, notarized, and compatible with supported architectures.
- A packaged smoke test completes handshake, availability query, cancellation, and shutdown.
- Unsupported platforms use an unavailable provider rather than a spawn loop.

## Quality and documentation

- Protocol fixtures pass in TypeScript and Swift.
- Failure-injection tests pass.
- Log-safety tests pass.
- Architecture dependency checks pass.
- Documentation links resolve.
- Canonical ownership is preserved without duplicated architectural decisions.

## Existing-application integration

- No second Electron bootstrap, BrowserWindow owner, preload root, application store, or packaging pipeline is introduced.
- Existing host files receive only narrow, documented integration changes.
- Existing trading, charting, stores, broker, order, and risk tests continue to pass unchanged unless the feature explicitly adds coverage.
