import Foundation

// Canonical spec: docs/apple-intelligence/context-and-prompt-budgeting.md.
// Deterministic, testable without invoking the model. Trims lowest-priority
// sections first (dealer scenarios/descriptive context, then extended
// indicators, then options, then secondary overlays) while position/risk
// evidence for a management task is never silently dropped — a task that
// needs it and doesn't have it is downgraded, not guessed at.

public struct BudgetedPrompt: Sendable {
    public let text: String
    public let omissions: [OmissionInput]
    /// True when a management task's required position/risk evidence could
    /// not be included — the caller must downgrade to observation-only
    /// rather than let the model invent management advice.
    public let downgradedToObservationOnly: Bool
}

public enum ContextBudgeter {
    // The model's context window (4096 tokens) has to fit the system
    // instructions, this budgeted prompt text, the @Generable output
    // schema FoundationModels encodes for GeneratedAnalysis, AND the
    // generated response itself — not just the prompt. This was 6000 chars
    // (roughly the whole 4096-token budget at ~4 chars/token, leaving
    // nothing for the rest) before GeneratedTradeDeskPlan's larger schema
    // pushed real requests over the limit (exceededContextWindowSize at
    // ~4800 tokens for a ~6000-char prompt). Lowered to leave real margin;
    // if the schema grows again, this needs to shrink further or the
    // schema itself needs trimming — the two trade off against each other.
    public static let maxPromptCharacters = 3500

    public static func build(from snapshot: AnalysisSnapshotInput) -> BudgetedPrompt {
        var includeOptions = snapshot.options != nil
        var includeStrategyPolicy = snapshot.strategyPolicy != nil
        var includeExtendedIndicators = true
        var levelLimit = snapshot.levels.count
        var candleLimit = candleCount(in: snapshot.candles)
        var omissions = snapshot.omissions

        let requiredPositionMissing = snapshot.isManagementTask && snapshot.position == nil
        let downgradedToObservationOnly = requiredPositionMissing

        func recompose() -> String {
            compose(
                snapshot: snapshot,
                includeOptions: includeOptions,
                includeStrategyPolicy: includeStrategyPolicy,
                includeExtendedIndicators: includeExtendedIndicators,
                levelLimit: levelLimit,
                candleLimit: candleLimit,
                downgraded: downgradedToObservationOnly
            )
        }

        var text = recompose()

        // Trim lowest priority first per context-and-prompt-budgeting.md's
        // priority table (1 position/risk never omitted .. 6 scenarios
        // trimmed first): options (4) and extended indicators (5) go before
        // candidate levels (3), which go before ever cutting into candles
        // (2) — candles are trimmed last among core evidence, and strategy
        // policy (1, a constraint not raw evidence) only degrades after all
        // of that.
        while text.count > maxPromptCharacters {
            if includeOptions {
                includeOptions = false
                omissions.append(
                    OmissionInput(
                        code: "options-trimmed",
                        category: "options",
                        reason: "budget",
                        originalCount: nil,
                        retainedCount: nil,
                        material: false
                    )
                )
            } else if includeExtendedIndicators {
                includeExtendedIndicators = false
                omissions.append(
                    OmissionInput(
                        code: "extended-indicators-trimmed",
                        category: "indicators",
                        reason: "budget",
                        originalCount: nil,
                        retainedCount: nil,
                        material: false
                    )
                )
            } else if levelLimit > 1 {
                let original = levelLimit
                levelLimit = max(1, levelLimit / 2)
                omissions.append(
                    OmissionInput(
                        code: "levels-trimmed",
                        category: "levels",
                        reason: "budget",
                        originalCount: original,
                        retainedCount: levelLimit,
                        material: false
                    )
                )
            } else if let currentCandleLimit = candleLimit, currentCandleLimit > 1 {
                let original = currentCandleLimit
                let reduced = max(1, currentCandleLimit / 2)
                candleLimit = reduced
                omissions.append(
                    OmissionInput(
                        code: "candles-trimmed",
                        category: "candles",
                        reason: "budget",
                        originalCount: original,
                        retainedCount: reduced,
                        material: true
                    )
                )
            } else if includeStrategyPolicy {
                includeStrategyPolicy = false
                omissions.append(
                    OmissionInput(
                        code: "strategy-policy-trimmed",
                        category: "strategyPolicy",
                        reason: "budget",
                        originalCount: nil,
                        retainedCount: nil,
                        material: true
                    )
                )
            } else {
                break
            }
            text = recompose()
        }

        // Every lever above (options, indicators, levels, candles, strategy
        // policy) can be exhausted while POSITION/MARKET — never trimmed,
        // since position/risk evidence must not be silently dropped — are
        // still large enough alone to exceed budget (e.g. a verbose
        // position or market payload). A hard truncation is the backstop
        // that guarantees the model actually receives a request under its
        // context window, rather than trusting every lever combined is
        // always sufficient. Prefer never reaching this path (the levers
        // above should ordinarily be enough); this exists so an unusually
        // large payload downgrades to a truncated-but-attemptable prompt
        // instead of unconditionally overflowing the model's window.
        if text.count > maxPromptCharacters {
            text = String(text.prefix(maxPromptCharacters))
            omissions.append(
                OmissionInput(
                    code: "prompt-truncated",
                    category: "prompt",
                    reason: "budget",
                    originalCount: nil,
                    retainedCount: nil,
                    material: true
                )
            )
        }

        return BudgetedPrompt(text: text, omissions: omissions, downgradedToObservationOnly: downgradedToObservationOnly)
    }

    /// Candles are the one section without a typed model here (opaque
    /// JSONValue). The wire shape (AnalysisSnapshotBuilder.ts) is
    /// `{ count, recent: Candle[] }`, not a bare array — the trim lever
    /// looks inside `recent` for that shape, or accepts a bare array
    /// directly for callers/fixtures that already supply one. Any other
    /// shape has no lever and is left to the strategy policy/options/level
    /// trims to make room.
    private static func candleCount(in candles: JSONValue) -> Int? {
        if case let .array(items) = candles { return items.count }
        if case let .object(fields) = candles, case let .array(items)? = fields["recent"] {
            return items.count
        }
        return nil
    }

    private static func trimmedCandles(_ candles: JSONValue, limit: Int?) -> JSONValue {
        guard let limit else { return candles }
        if case let .array(items) = candles {
            return .array(Array(items.suffix(limit)))
        }
        if case var .object(fields) = candles, case let .array(items)? = fields["recent"] {
            fields["recent"] = .array(Array(items.suffix(limit)))
            return .object(fields)
        }
        return candles
    }

    private static func compose(
        snapshot: AnalysisSnapshotInput,
        includeOptions: Bool,
        includeStrategyPolicy: Bool,
        includeExtendedIndicators: Bool,
        levelLimit: Int,
        candleLimit: Int?,
        downgraded: Bool
    ) -> String {
        var parts: [String] = []

        parts.append("SYMBOL \(snapshot.identity.symbol) TIMEFRAME \(snapshot.identity.timeframe)")
        parts.append("TRIGGER \(snapshot.trigger.kind) PRIORITY \(snapshot.trigger.priority): \(snapshot.trigger.reason)")

        if downgraded {
            parts.append("NOTE: position/risk evidence required for this management task is missing. Provide observation-only analysis — do not recommend hold/trim/exit actions.")
        }

        // Priority 1: position/risk (never silently omitted from the prompt
        // when present; downgrade above handles the case where it's absent
        // but required).
        if let position = snapshot.position {
            parts.append("POSITION: \(compactJSON(position))")
        }
        if includeStrategyPolicy, let policy = snapshot.strategyPolicy {
            parts.append("STRATEGY POLICY (constraints, not suggestions): \(compactJSON(policy))")
        }

        // Priority 2: candles and market structure.
        parts.append("MARKET: \(compactJSON(snapshot.market))")
        parts.append("CANDLES: \(compactJSON(trimmedCandles(snapshot.candles, limit: candleLimit)))")
        if includeExtendedIndicators {
            parts.append("INDICATORS: \(compactJSON(snapshot.indicators))")
        }

        // Priority 3: candidate levels, strongest-first, limited.
        let levels = Array(
            snapshot.levels
                .sorted { $0.strength > $1.strength }
                .prefix(levelLimit)
        )
        if !levels.isEmpty {
            let levelLines = levels.map { level in
                "  \(level.id): \(level.role) \(level.kind) at \(level.price), tested \(level.testCount)x, strength \(level.strength), source \(level.source)"
            }
            parts.append((["CANDIDATE LEVELS (only reference these ids for numeric levels):"] + levelLines).joined(separator: "\n"))
        }

        // Priority 4: options/chain.
        if includeOptions, let options = snapshot.options {
            parts.append("OPTIONS: \(compactJSON(options))")
        }

        if !snapshot.omissions.isEmpty {
            let omittedCodes = snapshot.omissions.map(\.code).joined(separator: ", ")
            parts.append("DECLARED OMISSIONS (already missing from source data, not budget trims): \(omittedCodes)")
        }

        return parts.joined(separator: "\n")
    }

    private static func compactJSON(_ value: JSONValue) -> String {
        guard let data = try? JSONEncoder().encode(value),
              let text = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return text
    }
}
