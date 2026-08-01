import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

// Canonical spec: docs/apple-intelligence/implementation-plan.md Phase 2
// (structured model adapter). Owns: snapshot decode -> budgeted prompt ->
// constrained generation -> grounding enforcement -> wire-shaped result
// payload. Kept separate from RequestHandler so the pipeline is testable
// without going through the actor/protocol-dispatch layer.

public enum AnalysisRunError: Error, Sendable, Equatable {
    case payloadInvalid
    case modelUnavailable
    case structuredOutputInvalid
    case guardrailRejection
    case runtimeFailure
}

public enum AnalysisRunner {
    public static let systemInstructions = """
        You are a technical market analyst assisting a 0DTE options trader. \
        Analyze only the supplied evidence. Reference candidate level ids \
        exactly as given for any numeric support/resistance level — never \
        invent a price that is not one of the supplied candidate levels. Do \
        not suggest order actions beyond the recommendation categories \
        provided. Be concise and cite specific supplied values.
        """

    /// Decodes the raw wire payload into a snapshot. `nil` means the
    /// payload didn't even parse — callers map that to `payload_invalid`.
    public static func decodeSnapshot(from payload: JSONValue?) -> AnalysisSnapshotInput? {
        guard let payload else { return nil }
        guard let data = try? JSONEncoder().encode(payload) else { return nil }
        return try? JSONDecoder().decode(AnalysisSnapshotInput.self, from: data)
    }

    /// Runs the full pipeline and returns a wire-ready result payload
    /// (JSONValue), or throws an `AnalysisRunError` that the caller maps to
    /// a `failed` event with a stable error code. Never returns an
    /// ungrounded numeric level.
    ///
    /// `analysisId` reuses the caller's requestId — one analysis run
    /// produces at most one result, so a separate id would only be another
    /// identifier to keep in sync for no benefit.
    public static func run(
        snapshot: AnalysisSnapshotInput,
        analysisId: String,
        isCancelled: @Sendable () -> Bool
    ) async throws -> JSONValue {
        let budgeted = ContextBudgeter.build(from: snapshot)

        #if canImport(FoundationModels)
        guard #available(macOS 26, *) else { throw AnalysisRunError.modelUnavailable }
        guard case .ready = AvailabilityService.current() else { throw AnalysisRunError.modelUnavailable }

        if isCancelled() { throw CancellationError() }

        let session = LanguageModelSession(instructions: systemInstructions)
        let response: LanguageModelSession.Response<GeneratedAnalysis>
        do {
            response = try await session.respond(to: budgeted.text, generating: GeneratedAnalysis.self)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw AnalysisRunError.runtimeFailure
        }

        if isCancelled() { throw CancellationError() }

        let generated = response.content
        let candidateIds = Set(snapshot.levels.map(\.id))

        let support = GroundingValidator.groundOrReject(
            generated.support.map { GroundingValidator.LevelReference(levelId: $0.levelId, price: $0.price) },
            candidateIds: candidateIds
        )
        let resistance = GroundingValidator.groundOrReject(
            generated.resistance.map { GroundingValidator.LevelReference(levelId: $0.levelId, price: $0.price) },
            candidateIds: candidateIds
        )

        let recommendation = budgeted.downgradedToObservationOnly ? "wait" : generated.recommendation.rawValue

        var levelsObject: [String: JSONValue] = [:]
        if let support { levelsObject["support"] = .object(["levelId": .string(support.levelId), "price": .number(support.price)]) }
        if let resistance { levelsObject["resistance"] = .object(["levelId": .string(resistance.levelId), "price": .number(resistance.price)]) }

        var warnings = generated.warnings
        if budgeted.downgradedToObservationOnly {
            warnings.append("Position/risk evidence required for this management task was unavailable; downgraded to observation-only.")
        }

        return .object([
            "resultSchemaVersion": .number(1),
            "analysisId": .string(analysisId),
            "context": contextIdentity(from: snapshot.identity),
            "generatedAt": .string(ISO8601DateFormatter().string(from: Date())),
            "recommendation": .string(recommendation),
            "setupState": .string(generated.setupState.rawValue),
            "bias": .string(generated.bias.rawValue),
            "levels": .object(levelsObject),
            "confidence": .number(min(1, max(0, generated.confidence))),
            "reasons": .array(generated.reasons.map { .object(["code": .string("model-cited"), "detail": .string($0)]) }),
            "warnings": .array(warnings.map(JSONValue.string)),
            "assumptions": .array(generated.assumptions.map(JSONValue.string)),
            "observedOmissions": .array(budgeted.omissions.map(omissionToJSON)),
            "summary": .string(generated.summary),
        ])
        #else
        throw AnalysisRunError.modelUnavailable
        #endif
    }

    private static func contextIdentity(from identity: AnalysisSnapshotInput.IdentityInput) -> JSONValue {
        var object: [String: JSONValue] = [
            "symbol": .string(identity.symbol),
            "timeframe": .string(identity.timeframe),
            "snapshotSequence": .number(Double(identity.snapshotSequence)),
            "positionVersion": .number(Double(identity.positionVersion)),
        ]
        if let candleCloseTime = identity.candleCloseTime { object["candleCloseTime"] = .string(candleCloseTime) }
        if let strategyPolicyVersion = identity.strategyPolicyVersion {
            object["strategyPolicyVersion"] = .number(Double(strategyPolicyVersion))
        }
        return .object(object)
    }

    private static func omissionToJSON(_ omission: OmissionInput) -> JSONValue {
        var object: [String: JSONValue] = [
            "code": .string(omission.code),
            "category": .string(omission.category),
            "reason": .string(omission.reason),
            "material": .bool(omission.material),
        ]
        if let originalCount = omission.originalCount { object["originalCount"] = .number(Double(originalCount)) }
        if let retainedCount = omission.retainedCount { object["retainedCount"] = .number(Double(retainedCount)) }
        return .object(object)
    }
}
