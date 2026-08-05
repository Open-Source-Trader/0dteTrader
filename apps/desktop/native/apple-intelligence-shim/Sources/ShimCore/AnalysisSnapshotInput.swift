import Foundation

// Canonical spec: docs/apple-intelligence/data-contracts.md. Decodes the
// wire-level AnalysisSnapshot (see apps/desktop/src/features/appleIntelligence/
// types.ts) into a Swift value the budgeter and prompt assembler can work
// with. Deliberately loose on the free-form sections (market/candles/
// indicators/options/position/strategyPolicy) — those are rendered as
// opaque JSON text in the prompt, not re-modeled field by field, since the
// budgeter's job is to prioritize *categories*, not parse trading semantics
// FoundationModels doesn't need typed access to.

public struct CandidateLevelInput: Codable, Sendable {
    public let id: String
    public let kind: String
    public let role: String
    public let price: Double
    public let evidence: String
    public let testCount: Int
    public let recency: String
    public let strength: Double
    public let source: String
}

public struct OmissionInput: Codable, Sendable {
    public let code: String
    public let category: String
    public let reason: String
    public let originalCount: Int?
    public let retainedCount: Int?
    public let material: Bool
}

public struct AnalysisSnapshotInput: Codable, Sendable {
    public let snapshotSchemaVersion: Int
    public let identity: IdentityInput
    public let trigger: TriggerInput
    public let market: JSONValue
    public let candles: JSONValue
    public let indicators: JSONValue
    public let levels: [CandidateLevelInput]
    public let options: JSONValue?
    public let position: JSONValue?
    public let strategyPolicy: JSONValue?
    /// The setup tracked from the previous analysis for this instrument, if
    /// any (see setupLifecycleHysteresis.ts on the TypeScript side) — tells
    /// the model to continue an analysis rather than start from a blank
    /// slate. Absent when no live, non-terminal setup is currently tracked.
    public let priorSetup: JSONValue?
    public let quality: JSONValue
    public let omissions: [OmissionInput]

    /// Explicit memberwise init with `priorSetup` defaulted to `nil` — the
    /// synthesized one requires every field positionally, which would force
    /// every existing call site (decode-from-wire callers never construct
    /// this directly; only test fixtures do) to supply a field that's
    /// legitimately absent most of the time. Decoding from the wire still
    /// uses Codable's own synthesized `init(from:)`, untouched by this.
    public init(
        snapshotSchemaVersion: Int,
        identity: IdentityInput,
        trigger: TriggerInput,
        market: JSONValue,
        candles: JSONValue,
        indicators: JSONValue,
        levels: [CandidateLevelInput],
        options: JSONValue? = nil,
        position: JSONValue? = nil,
        strategyPolicy: JSONValue? = nil,
        priorSetup: JSONValue? = nil,
        quality: JSONValue,
        omissions: [OmissionInput]
    ) {
        self.snapshotSchemaVersion = snapshotSchemaVersion
        self.identity = identity
        self.trigger = trigger
        self.market = market
        self.candles = candles
        self.indicators = indicators
        self.levels = levels
        self.options = options
        self.position = position
        self.strategyPolicy = strategyPolicy
        self.priorSetup = priorSetup
        self.quality = quality
        self.omissions = omissions
    }

    public struct IdentityInput: Codable, Sendable {
        public let snapshotId: String
        public let capturedAt: String
        public let symbol: String
        public let timeframe: String
        public let candleCloseTime: String?
        public let snapshotSequence: Int
        public let positionVersion: Int
        public let strategyPolicyVersion: Int?
    }

    public struct TriggerInput: Codable, Sendable {
        public let kind: String
        public let priority: String
        public let reason: String
    }

    /// A management-task snapshot is one whose trigger implies position
    /// evaluation is in scope. Required-evidence enforcement
    /// (context-and-prompt-budgeting.md, priority 1) only applies to these.
    public var isManagementTask: Bool {
        trigger.kind == "position-change" || trigger.kind == "material-change"
    }
}
