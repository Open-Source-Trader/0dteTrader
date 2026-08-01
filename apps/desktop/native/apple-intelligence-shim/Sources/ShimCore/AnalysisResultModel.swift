import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

// Canonical spec: docs/apple-intelligence/data-contracts.md. This is the
// structured-generation half of AnalysisResult — the wire-level fields
// (resultSchemaVersion, analysisId, context, generatedAt) are attached by
// RequestHandler after generation, not asked of the model, since the model
// has no reason to invent a UUID or a timestamp.

#if canImport(FoundationModels)
@available(macOS 26, *)
@Generable
enum GeneratedRecommendation: String, Sendable {
    case wait, enter, hold, trim, exit, avoid
}

@available(macOS 26, *)
@Generable
enum GeneratedSetupState: String, Sendable {
    case none, forming, confirmed, extended, invalidated
}

@available(macOS 26, *)
@Generable
enum GeneratedBias: String, Sendable {
    case bullish, bearish, neutral, mixed
}

/// A generated numeric level reference. `levelId` must match a candidate
/// level supplied in the snapshot — this struct only carries what the model
/// produced; `GroundingValidator` checks the match afterward. A `levelId`
/// that doesn't match any supplied candidate makes the whole reference
/// ungrounded and it is dropped, never trusted at face value.
@available(macOS 26, *)
@Generable
struct GeneratedLevelReference: Sendable {
    @Guide(description: "Must exactly match the id of one of the supplied candidate levels")
    var levelId: String
    @Guide(description: "The price of the referenced candidate level, copied from that candidate")
    var price: Double
}

@available(macOS 26, *)
@Generable
enum GeneratedTradeDeskAction: String, Sendable {
    case wait, enter, hold, scale, exit, avoid
}

@available(macOS 26, *)
@Generable
struct GeneratedUnderlyingZone: Sendable {
    @Guide(description: "Must match a supplied candidate level id")
    var lowLevelId: String
    var low: Double
    @Guide(description: "Must match a supplied candidate level id")
    var highLevelId: String
    var high: Double
}

@available(macOS 26, *)
@Generable
struct GeneratedContractZone: Sendable {
    var low: Double
    var high: Double
}

@available(macOS 26, *)
@Generable
struct GeneratedScaleAdvice: Sendable {
    @Guide(description: "in | out")
    var direction: String
    var condition: String
}

@available(macOS 26, *)
@Generable
struct GeneratedTradeDeskTarget: Sendable {
    @Guide(description: "first | runner | final")
    var role: String
    var contractPrice: Double
    var condition: String?
}

@available(macOS 26, *)
@Generable
struct GeneratedTradeDeskEntry: Sendable {
    var underlying: GeneratedUnderlyingZone?
    var contract: GeneratedContractZone?
    var preferredContractPrice: Double?
}

@available(macOS 26, *)
@Generable
struct GeneratedTradeDeskInvalidation: Sendable {
    var underlying: GeneratedLevelReference?
    var contractPrice: Double?
}

/// Mirrors TypeScript's `TradeDeskPlan` (types.ts). Optional on the
/// generated result — see data-contracts.md for the decision-invariant
/// table that governs which fields must be present for a given `action`;
/// that rule is enforced downstream (TS `validateTradeDeskInvariants`), not
/// here, since it needs the current position/context to evaluate. Contract
/// premium fields carry no per-field @Guide restating the "grounded against
/// the selected contract" requirement — that's stated once in
/// AnalysisRunner.systemInstructions, and GroundingValidator drops any
/// ungrounded value regardless of what the model was told.
@available(macOS 26, *)
@Generable
struct GeneratedTradeDeskPlan: Sendable {
    var action: GeneratedTradeDeskAction
    @Guide(description: "Required only when action is scale")
    var scaleAdvice: GeneratedScaleAdvice?
    @Guide(description: "Short label for the current setup, e.g. 'Bullish pullback'")
    var setupLabel: String
    var summary: String
    var entry: GeneratedTradeDeskEntry?
    var invalidation: GeneratedTradeDeskInvalidation?
    @Guide(description: "Up to 3 contract-premium targets, ordered first to final")
    var contractTargets: [GeneratedTradeDeskTarget]
    var holdConditions: [String]
    var scaleConditions: [String]
    var exitConditions: [String]
    @Guide(description: "low | medium | high")
    var confidence: String?
}

@available(macOS 26, *)
@Generable
struct GeneratedAnalysis: Sendable {
    @Guide(description: "wait | enter | hold | trim | exit | avoid")
    var recommendation: GeneratedRecommendation

    @Guide(description: "none | forming | confirmed | extended | invalidated")
    var setupState: GeneratedSetupState

    @Guide(description: "bullish | bearish | neutral | mixed")
    var bias: GeneratedBias

    @Guide(description: "Support level, only if grounded in a supplied candidate level")
    var support: GeneratedLevelReference?

    @Guide(description: "Resistance level, only if grounded in a supplied candidate level")
    var resistance: GeneratedLevelReference?

    @Guide(description: "Confidence in this interpretation, 0.0 to 1.0. Not a calibrated probability.")
    var confidence: Double

    @Guide(description: "2 to 5 short reasons citing specific supplied evidence")
    var reasons: [String]

    @Guide(description: "Warnings about stale, omitted, or conflicting evidence, if any")
    var warnings: [String]

    @Guide(description: "Assumptions made where evidence was incomplete, if any")
    var assumptions: [String]

    @Guide(description: "One paragraph plain-language summary")
    var summary: String

    var tradeDeskPlan: GeneratedTradeDeskPlan?
}
#endif

/// Grounding rule (data-contracts.md): every recommended numeric level must
/// reference a supplied candidate-level identifier. Runs regardless of
/// FoundationModels availability so it stays testable on every platform.
public enum GroundingValidator {
    public struct LevelReference: Sendable, Equatable {
        public let levelId: String
        public let price: Double

        public init(levelId: String, price: Double) {
            self.levelId = levelId
            self.price = price
        }
    }

    /// Returns the reference unchanged if `levelId` matches a supplied
    /// candidate, or nil if it does not — an ungrounded level must never be
    /// silently promoted to the result.
    public static func groundOrReject(
        _ reference: LevelReference?,
        candidateIds: Set<String>
    ) -> LevelReference? {
        guard let reference else { return nil }
        guard candidateIds.contains(reference.levelId) else { return nil }
        return reference
    }

    /// Contract-premium prices have no candidate-level id to match against
    /// (unlike underlying prices) — instead they're grounded against the
    /// supplied selected contract's own bid/ask/last, mirroring the
    /// TypeScript-side `isValidContractPremium` bound
    /// (tradeDeskPresenter.ts). A generated price outside a generous
    /// multiple of the contract's own reference prices, or one produced with
    /// no contract supplied at all, is ungrounded and must be dropped.
    public static func groundOrRejectContractPrice(
        _ price: Double?,
        contractReference: Double?
    ) -> Double? {
        guard let price, price.isFinite, price > 0 else { return nil }
        guard let contractReference, contractReference.isFinite, contractReference > 0 else { return nil }
        guard price <= contractReference * 20 else { return nil }
        return price
    }
}
