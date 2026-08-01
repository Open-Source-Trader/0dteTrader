import Foundation

// Metadata-only operational telemetry for the Swift sidecar. Canonical spec:
// docs/apple-intelligence/testing-and-observability.md ("Required metrics" —
// analysis_duration_ms, snapshot_bytes, prompt_chars, omission_codes) and
// security-boundary.md ("Logging" — stderr/telemetry may record request id,
// trigger category, duration, byte counts, omission codes, terminal state,
// safe error code, versions; never raw snapshots, prompts, full generated
// output, exact positions, order details, credentials, or account
// identifiers). Stdout stays protocol-only (main.swift's existing rule) —
// this type only ever produces text meant for stderr via `logDiagnostic`.
//
// Mirrors the Node-side telemetry.cjs shape (one structured event name plus
// an allowlisted, primitives-only payload) so main-process and sidecar
// diagnostics read the same way, without sharing code across the
// language boundary.

/// One emitted telemetry event: a short stable name plus metadata-only
/// fields. `describe()` renders it the same way regardless of sink so tests
/// can assert on the exact text a diagnostic line would contain.
public struct ShimTelemetryEvent: Sendable, Equatable {
    public let name: String
    public let requestId: String?
    public let analysisDurationMs: Int?
    public let snapshotBytes: Int?
    public let promptChars: Int?
    public let omissionCodes: [String]?
    public let analysisTerminalState: String?

    public init(
        name: String,
        requestId: String? = nil,
        analysisDurationMs: Int? = nil,
        snapshotBytes: Int? = nil,
        promptChars: Int? = nil,
        omissionCodes: [String]? = nil,
        analysisTerminalState: String? = nil
    ) {
        self.name = name
        self.requestId = requestId
        self.analysisDurationMs = analysisDurationMs
        self.snapshotBytes = snapshotBytes
        self.promptChars = promptChars
        self.omissionCodes = omissionCodes
        self.analysisTerminalState = analysisTerminalState
    }

    /// Renders as one single-line, machine-greppable string. Deliberately
    /// not JSON — stdout is the only NDJSON channel in this process
    /// (protocol.md), and stderr diagnostics have never used it (see
    /// `logDiagnostic` in main.swift), so this keeps the same plain-text
    /// shape as every other diagnostic line the shim already emits.
    public func describe() -> String {
        var parts = ["event=\(name)"]
        if let requestId { parts.append("requestId=\(requestId)") }
        if let analysisDurationMs { parts.append("analysisDurationMs=\(analysisDurationMs)") }
        if let snapshotBytes { parts.append("snapshotBytes=\(snapshotBytes)") }
        if let promptChars { parts.append("promptChars=\(promptChars)") }
        if let omissionCodes, !omissionCodes.isEmpty {
            parts.append("omissionCodes=\(omissionCodes.joined(separator: ","))")
        }
        if let analysisTerminalState { parts.append("analysisTerminalState=\(analysisTerminalState)") }
        return parts.joined(separator: " ")
    }
}

/// Injectable sink so `AnalysisRunner`/`RequestHandler` stay testable
/// without touching a real file handle; `main.swift` wires the production
/// sink to `logDiagnostic` (stderr).
public typealias ShimTelemetrySink = @Sendable (ShimTelemetryEvent) -> Void

/// Default production sink is a no-op; the executable target supplies the
/// real one at startup so `ShimCore` never needs to import Foundation's
/// FileHandle-writing concerns itself.
public let noopTelemetrySink: ShimTelemetrySink = { _ in }
