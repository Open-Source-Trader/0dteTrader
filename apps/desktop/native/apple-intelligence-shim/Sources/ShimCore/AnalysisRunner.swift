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
        You are a technical market analyst assisting an intraday 0DTE \
        options trader. Analyze only the supplied evidence for the \
        supplied symbol and timeframe — never invent market facts. \
        Reference underlying levels by their candidate level id only; \
        never write a numeric underlying price yourself, in a structured \
        field or in free text. Contract premium prices must stay close to \
        the supplied selected contract's own bid/ask/last. A level cross \
        or touch requires price-action confirmation before it counts as \
        significant — do not treat a single touch as confirmation. Use \
        only the provided recommendation and setup categories. Be concise \
        and conditional: state what confirms or invalidates the setup, \
        not just a conclusion.
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
    /// a `failed` event with a stable error code. Every field explicitly
    /// modeled as a price (support/resistance, entry/invalidation/target
    /// prices) is grounded — resolved from the snapshot's own candidate
    /// levels or bounded against the selected contract, never trusted from
    /// the model. This does NOT cover numbers that may appear inside free
    /// text (`summary`, `reasons`, `warnings`, `assumptions`,
    /// `holdConditions`, `exitConditions`) — those are prose the model
    /// produces and are not validated as numeric claims.
    ///
    /// `analysisId` reuses the caller's requestId — one analysis run
    /// produces at most one result, so a separate id would only be another
    /// identifier to keep in sync for no benefit.
    public static func run(
        snapshot: AnalysisSnapshotInput,
        analysisId: String,
        isCancelled: @Sendable () -> Bool,
        telemetry: ShimTelemetrySink = noopTelemetrySink
    ) async throws -> JSONValue {
        let startedAt = Date()
        let budgeted = ContextBudgeter.build(from: snapshot)
        // Byte/char counts only — never the snapshot or prompt text itself
        // (security-boundary.md "Logging"). `snapshotBytes` re-encodes the
        // already-decoded snapshot purely to measure its size (the raw wire
        // bytes aren't retained past decode); `promptChars` is the exact
        // assembled-prompt length ContextBudgeter already computed.
        let snapshotBytes = (try? JSONEncoder().encode(snapshot))?.count
        defer {
            telemetry(
                ShimTelemetryEvent(
                    name: "analysis_context",
                    requestId: analysisId,
                    analysisDurationMs: Int(Date().timeIntervalSince(startedAt) * 1000),
                    snapshotBytes: snapshotBytes,
                    promptChars: budgeted.text.count,
                    omissionCodes: budgeted.omissions.map(\.code)
                )
            )
        }

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
        let candidatePrices = Dictionary(
            snapshot.levels.map { ($0.id, $0.price) },
            uniquingKeysWith: { first, _ in first }
        )

        let support = GroundingValidator.groundOrReject(
            levelId: generated.support?.levelId,
            candidatePrices: candidatePrices
        )
        let resistance = GroundingValidator.groundOrReject(
            levelId: generated.resistance?.levelId,
            candidatePrices: candidatePrices
        )

        let recommendation = budgeted.downgradedToObservationOnly ? "wait" : generated.recommendation.rawValue

        var levelsObject: [String: JSONValue] = [:]
        if let support { levelsObject["support"] = .object(["levelId": .string(support.levelId), "price": .number(support.price)]) }
        if let resistance { levelsObject["resistance"] = .object(["levelId": .string(resistance.levelId), "price": .number(resistance.price)]) }

        var warnings = generated.warnings
        if budgeted.downgradedToObservationOnly {
            warnings.append("Position/risk evidence required for this management task was unavailable; downgraded to observation-only.")
        }

        var resultObject: [String: JSONValue] = [
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
        ]

        if !budgeted.downgradedToObservationOnly, let plan = generated.tradeDeskPlan {
            let contractReference = selectedContractReferencePrice(from: snapshot.options)
            let snapshotId = snapshot.identity.snapshotId
            if let groundedPlan = groundTradeDeskPlan(
                plan,
                candidatePrices: candidatePrices,
                contractReference: contractReference,
                snapshotId: snapshotId
            ) {
                resultObject["tradeDeskPlan"] = groundedPlan
            }
        }

        return .object(resultObject)
        #else
        throw AnalysisRunError.modelUnavailable
        #endif
    }

    #if canImport(FoundationModels)
    /// Bid/ask/last of the snapshot's selected contract, if supplied — the
    /// only reference a generated contract-premium price can be grounded
    /// against, since `options` is opaque JSON with no typed model here
    /// (AnalysisSnapshotInput's doc comment on why it stays untyped).
    @available(macOS 26, *)
    private static func selectedContractReferencePrice(from options: JSONValue?) -> Double? {
        guard case let .object(root)? = options, case let .object(contract)? = root["selectedContract"] else {
            return nil
        }
        for key in ["last", "ask", "bid"] {
            if case let .number(value)? = contract[key], value.isFinite, value > 0 {
                return value
            }
        }
        return nil
    }

    /// Grounds every price-bearing field in a generated trade-desk plan
    /// before it is trusted. Underlying prices are resolved from
    /// `candidatePrices[levelId]` — the model supplies only an id, never a
    /// price, so there is no generated underlying number to distrust in the
    /// first place (GroundingValidator.groundOrReject). Contract-premium
    /// prices have no id to key off, so they're bounded against the
    /// supplied selected contract's own reference price instead
    /// (GroundingValidator.groundOrRejectContractPrice) — that field IS a
    /// generated number, just one checked against a numeric bound rather
    /// than resolved by lookup. A field that fails grounding is omitted,
    /// never trusted at face value or replaced with a guess.
    /// `evidenceId`/`snapshotId` are attached here, not asked of the model.
    @available(macOS 26, *)
    private static func groundTradeDeskPlan(
        _ plan: GeneratedTradeDeskPlan,
        candidatePrices: [String: Double],
        contractReference: Double?,
        snapshotId: String
    ) -> JSONValue? {
        func groundedLevel(_ ref: GeneratedLevelReference?) -> JSONValue? {
            guard let grounded = GroundingValidator.groundOrReject(
                levelId: ref?.levelId,
                candidatePrices: candidatePrices
            ) else { return nil }
            return .object([
                "value": .number(grounded.price),
                "priceDomain": .string("underlying"),
                "evidenceId": .string(grounded.levelId),
                "snapshotId": .string(snapshotId),
                "levelId": .string(grounded.levelId),
            ])
        }

        func groundedContractPrice(_ price: Double?, evidenceId: String) -> JSONValue? {
            guard let grounded = GroundingValidator.groundOrRejectContractPrice(price, contractReference: contractReference) else {
                return nil
            }
            return .object([
                "value": .number(grounded),
                "priceDomain": .string("contract-premium"),
                "evidenceId": .string(evidenceId),
                "snapshotId": .string(snapshotId),
            ])
        }

        var entryObject: [String: JSONValue] = [:]
        if let entry = plan.entry {
            if let underlying = entry.underlying,
               let lowPrice = candidatePrices[underlying.lowLevelId],
               let highPrice = candidatePrices[underlying.highLevelId] {
                entryObject["underlying"] = .object([
                    "low": .number(min(lowPrice, highPrice)),
                    "high": .number(max(lowPrice, highPrice)),
                    "priceDomain": .string("underlying"),
                    "evidenceId": .string(underlying.lowLevelId),
                    "snapshotId": .string(snapshotId),
                ])
            }
            if let contract = entry.contract,
               GroundingValidator.groundOrRejectContractPrice(contract.low, contractReference: contractReference) != nil,
               GroundingValidator.groundOrRejectContractPrice(contract.high, contractReference: contractReference) != nil {
                entryObject["contract"] = .object([
                    "low": .number(contract.low),
                    "high": .number(contract.high),
                    "priceDomain": .string("contract-premium"),
                    "evidenceId": .string("selected-contract"),
                    "snapshotId": .string(snapshotId),
                ])
            }
            if let preferred = groundedContractPrice(entry.preferredContractPrice, evidenceId: "selected-contract") {
                entryObject["preferredContractPrice"] = preferred
            }
        }

        var invalidationObject: [String: JSONValue] = [:]
        if let invalidation = plan.invalidation {
            if let underlyingPrice = groundedLevel(invalidation.underlying) {
                invalidationObject["underlying"] = .object(["operator": .string("below"), "price": underlyingPrice])
            }
            if let contractPrice = groundedContractPrice(invalidation.contractPrice, evidenceId: "selected-contract") {
                invalidationObject["contract"] = .object(["operator": .string("below"), "price": contractPrice])
            }
        }

        let contractTargets = plan.contractTargets.compactMap { target -> JSONValue? in
            guard let price = groundedContractPrice(target.contractPrice, evidenceId: "selected-contract") else { return nil }
            var object: [String: JSONValue] = ["role": .string(target.role), "price": price]
            if let condition = target.condition { object["condition"] = .string(condition) }
            return .object(object)
        }

        var planObject: [String: JSONValue] = [
            "action": .string(plan.action.rawValue),
            "setupLabel": .string(plan.setupLabel),
            "summary": .string(plan.summary),
            "targets": .object(["contract": .array(contractTargets)]),
            "management": .object([
                "holdConditions": .array(plan.holdConditions.map(JSONValue.string)),
                "scaleConditions": .array(plan.scaleConditions.map(JSONValue.string)),
                "exitConditions": .array(plan.exitConditions.map(JSONValue.string)),
            ]),
        ]
        if !entryObject.isEmpty { planObject["entry"] = .object(entryObject) }
        if !invalidationObject.isEmpty { planObject["invalidation"] = .object(invalidationObject) }
        if let scaleAdvice = plan.scaleAdvice, ["in", "out"].contains(scaleAdvice.direction) {
            planObject["scaleAdvice"] = .object([
                "direction": .string(scaleAdvice.direction),
                "condition": .string(scaleAdvice.condition),
            ])
        }
        if let confidence = plan.confidence, ["low", "medium", "high"].contains(confidence) {
            planObject["confidence"] = .string(confidence)
        }

        return .object(planObject)
    }
    #endif

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
