# Packaging, Signing, and Platform Compatibility

> Integration constraint: implement this capability through the existing Electron main, preload, lifecycle, build, packaging, and test patterns. Do not create parallel application infrastructure.

This file owns native binary build, location, resolution, signing, notarization, and release verification.

## Binary model

Build one Swift executable for every supported desktop architecture. A universal binary is acceptable only when release tooling verifies all required slices.

The executable is added to the existing Electron packaging pipeline and shipped with the application. It is not downloaded or updated independently.

## Packaged location

Use a fixed signed location inside the application bundle, such as:

```text
0dteTrader.app/
  Contents/
    MacOS/
      0dteTrader
    Resources/
      native/
        apple-intelligence-shim
```

The precise location must follow the repository's current Electron packaging conventions. Extend the current configuration rather than introducing a second packaging path.

## Path resolution

- Packaged mode: resolve from `process.resourcesPath` or the packager’s canonical resource location.
- Development mode: use one deterministic repository-relative build path.
- Never search arbitrary PATH locations.
- Never accept a renderer-provided path.
- Reject a missing, non-executable, unexpected, or architecture-incompatible binary.

## Signing and notarization

- Include the sidecar in application code signing.
- Include it in notarization.
- Verify executable permission after packaging.
- Verify the packaged binary identity and architecture in CI or release automation.
- Do not place the sidecar in a writable update location separate from the signed app.

## Platform availability

- Unsupported macOS versions return an unavailable provider state.
- Non-macOS development and CI use an unavailable provider or fake shim.
- Application build success must not require Apple Intelligence availability.
- Do not attempt repeated child-process spawn on unsupported platforms.
- Feature gating uses runtime capability, not hardware-name assumptions.

## Release smoke test

On a supported signed macOS build:

1. Launch the packaged application from its installed path.
2. Resolve and spawn the packaged sidecar.
3. Complete the protocol handshake.
4. Query Foundation Models availability.
5. Execute a bounded test request when availability permits.
6. Cancel a test request.
7. Perform graceful shutdown.
8. Confirm no sensitive payload content appears in logs.

## Gotchas

- Development success does not prove packaged path resolution.
- A present file may lack executable permission.
- A signed parent application does not automatically prove the nested executable is signed correctly.
- Architecture mismatch may appear only on another supported Mac.
- stdout diagnostics can corrupt the production protocol even when local tests tolerate them.
