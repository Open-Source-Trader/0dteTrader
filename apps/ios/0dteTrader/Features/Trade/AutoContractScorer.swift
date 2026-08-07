import Foundation

enum AutoScoringError: Error, Equatable {
    case invalid(String)
}

enum AutoContractScorer {
    private static let maxQuoteAge: TimeInterval = 5
    private static let maxFutureSkew: TimeInterval = 2
    private static let maxAnalyticsAge: TimeInterval = 60

    private struct Eligible {
        let candidate: AutoScoringCandidate
        let mid: Double
        let spreadBps: Double
        let premiumDollars: Double
        let atmDistance: Double
        var raw = AutoScoringContributions.zero
        var normalized = AutoScoringContributions.zero
        var weighted = AutoScoringContributions.zero
        var score = 0.0
    }

    static func score(
        request: AutoScoringRequest,
        preferences: AutoScoringPreferences,
        candidates input: [AutoScoringCandidate],
        serverTime: Date
    ) throws -> AutoScoringResult {
        try validate(request: request, serverTime: serverTime)
        try validate(preferences: preferences)

        let candidates = input.sorted(by: candidateOrder)
        let strikeWindow = buildStrikeWindow(
            candidates: candidates,
            request: request,
            strikeRungs: preferences.strikeRungs
        )
        var exclusions: [AutoScoringExclusion] = []
        var eligible: [Eligible] = []

        for candidate in candidates {
            if let reason = exclusionReason(
                candidate: candidate,
                request: request,
                preferences: preferences,
                strikeWindow: strikeWindow,
                serverTime: serverTime
            ) {
                exclusions.append(AutoScoringExclusion(symbol: candidate.symbol, reason: reason))
                continue
            }
            guard let bid = candidate.bid, let ask = candidate.ask else { continue }
            let mid = (bid + ask) / 2
            eligible.append(Eligible(
                candidate: candidate,
                mid: mid,
                spreadBps: ((ask - bid) / mid) * 10_000,
                premiumDollars: mid * 100,
                atmDistance: abs(candidate.strike - request.spot)
            ))
        }

        let rankedAt = timestamp(serverTime)
        guard !eligible.isEmpty else {
            return AutoScoringResult(
                rankings: [],
                exclusions: exclusions,
                selectedSymbol: nil,
                noPass: true,
                requiresConfirmation: true,
                rankedAt: rankedAt
            )
        }

        let ivMedian = median(eligible.compactMap(\.candidate.impliedVolatility))
        for index in eligible.indices {
            let candidate = eligible[index].candidate
            guard let delta = candidate.delta,
                  let gamma = candidate.gamma,
                  let impliedVolatility = candidate.impliedVolatility,
                  let openInterest = candidate.openInterest
            else { continue }
            eligible[index].raw = AutoScoringContributions(
                delta: -abs(abs(delta) - preferences.targetAbsDelta),
                spread: -eligible[index].spreadBps,
                openInterest: Double(openInterest),
                gamma: preferences.gammaMode == .seek ? abs(gamma) : -abs(gamma),
                iv: ivMedian - impliedVolatility
            )
        }

        let totalWeight = preferences.weights.values.reduce(0, +)
        for dimension in Dimension.allCases {
            let values = eligible.map { dimension.value(from: $0.raw) }
            guard let minimum = values.min(), let maximum = values.max() else { continue }
            for index in eligible.indices {
                let normalized = maximum == minimum
                    ? 1
                    : (dimension.value(from: eligible[index].raw) - minimum) / (maximum - minimum)
                dimension.set(normalized, on: &eligible[index].normalized)
                dimension.set(
                    normalized * dimension.value(from: preferences.weights) / totalWeight,
                    on: &eligible[index].weighted
                )
            }
        }
        for index in eligible.indices {
            eligible[index].score = eligible[index].weighted.values.reduce(0, +)
        }
        eligible.sort(by: eligibleOrder)

        let rankings = eligible.enumerated().map { index, item in
            AutoScoringRanking(
                rank: index + 1,
                candidate: item.candidate,
                score: item.score,
                rationale: AutoScoringRationale(
                    summary: summary(
                        index: index,
                        rankings: eligible,
                        exclusions: exclusions,
                        request: request,
                        preferences: preferences
                    ),
                    mid: item.mid,
                    spreadBps: item.spreadBps,
                    premiumDollars: item.premiumDollars,
                    atmDistance: item.atmDistance,
                    normalized: item.normalized,
                    weighted: item.weighted
                )
            )
        }
        return AutoScoringResult(
            rankings: rankings,
            exclusions: exclusions,
            selectedSymbol: rankings[0].candidate.symbol,
            noPass: false,
            requiresConfirmation: true,
            rankedAt: rankedAt
        )
    }

    private static func validate(request: AutoScoringRequest, serverTime: Date) throws {
        guard !request.underlying.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw AutoScoringError.invalid("underlying")
        }
        guard request.expiration.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else {
            throw AutoScoringError.invalid("expiration")
        }
        guard request.spot.isFinite, request.spot > 0 else { throw AutoScoringError.invalid("spot") }
        guard serverTime.timeIntervalSince1970.isFinite else { throw AutoScoringError.invalid("serverTime") }
    }

    private static func validate(preferences: AutoScoringPreferences) throws {
        guard preferences.schemaVersion == 1 else { throw AutoScoringError.invalid("schemaVersion") }
        guard (0.01...0.99).contains(preferences.targetAbsDelta),
              (0...20).contains(preferences.strikeRungs),
              (0...10_000).contains(preferences.maxSpreadBps),
              preferences.maxPremiumDollars.isFinite,
              preferences.maxPremiumDollars > 0,
              preferences.maxPremiumDollars <= 1_000_000,
              (0...1_000_000_000).contains(preferences.minOpenInterest)
        else { throw AutoScoringError.invalid("preferences") }
        guard preferences.weights.values.allSatisfy({ $0.isFinite && (0...1).contains($0) }),
              preferences.weights.values.reduce(0, +) > 0
        else { throw AutoScoringError.invalid("weights") }
    }

    private static func buildStrikeWindow(
        candidates: [AutoScoringCandidate],
        request: AutoScoringRequest,
        strikeRungs: Int
    ) -> Set<Double> {
        let strikes = Array(Set(candidates.filter {
            $0.expiration == request.expiration && $0.optionType == request.optionType && $0.strike.isFinite
        }.map(\.strike))).sorted()
        guard !strikes.isEmpty else { return [] }
        var anchor = 0
        for index in strikes.indices.dropFirst() {
            let distance = abs(strikes[index] - request.spot)
            let bestDistance = abs(strikes[anchor] - request.spot)
            if distance < bestDistance || (
                distance == bestDistance && (
                    request.optionType == .call
                        ? strikes[index] > strikes[anchor]
                        : strikes[index] < strikes[anchor]
                )
            ) {
                anchor = index
            }
        }
        let lower = max(0, anchor - strikeRungs)
        let upper = min(strikes.count, anchor + strikeRungs + 1)
        return Set(strikes[lower..<upper])
    }

    private static func exclusionReason(
        candidate: AutoScoringCandidate,
        request: AutoScoringRequest,
        preferences: AutoScoringPreferences,
        strikeWindow: Set<Double>,
        serverTime: Date
    ) -> AutoScoringExclusionReason? {
        if candidate.expiration != request.expiration { return .wrongExpiration }
        if candidate.optionType != request.optionType { return .wrongOptionType }
        if !strikeWindow.contains(candidate.strike) { return .outsideStrikeWindow }
        guard let bid = candidate.bid, let ask = candidate.ask, let quoteTimestamp = candidate.quoteTimestamp else {
            return .missingQuote
        }
        let mid = (bid + ask) / 2
        guard bid.isFinite, ask.isFinite, bid >= 0, ask > 0, ask >= bid, mid.isFinite, mid > 0,
              let quoteTime = parseTimestamp(quoteTimestamp)
        else { return .invalidQuote }
        if quoteTime.timeIntervalSince(serverTime) > maxFutureSkew { return .futureQuote }
        if serverTime.timeIntervalSince(quoteTime) > maxQuoteAge { return .staleQuote }
        guard let delta = candidate.delta, delta.isFinite else { return .missingDelta }
        guard let gamma = candidate.gamma, gamma.isFinite else { return .missingGamma }
        guard let impliedVolatility = candidate.impliedVolatility,
              impliedVolatility.isFinite,
              impliedVolatility >= 0
        else { return .missingIV }
        guard let openInterest = candidate.openInterest, openInterest >= 0 else { return .missingOpenInterest }
        guard let analyticsTimestamp = candidate.analyticsTimestamp,
              let analyticsTime = parseTimestamp(analyticsTimestamp),
              serverTime.timeIntervalSince(analyticsTime) <= maxAnalyticsAge,
              analyticsTime.timeIntervalSince(serverTime) <= maxFutureSkew
        else { return .staleAnalytics }
        if abs(delta) > 1 { return .deltaOutOfRange }
        let spreadBps = ((ask - bid) / mid) * 10_000
        if spreadBps > preferences.maxSpreadBps { return .spreadTooWide }
        if mid * 100 > preferences.maxPremiumDollars { return .premiumTooHigh }
        if openInterest < preferences.minOpenInterest { return .openInterestTooLow }
        return nil
    }

    private static func candidateOrder(_ left: AutoScoringCandidate, _ right: AutoScoringCandidate) -> Bool {
        if left.strike != right.strike { return left.strike < right.strike }
        if left.expiration != right.expiration { return left.expiration < right.expiration }
        if left.optionType.rawValue != right.optionType.rawValue {
            return left.optionType.rawValue < right.optionType.rawValue
        }
        return left.symbol < right.symbol
    }

    private static func eligibleOrder(_ left: Eligible, _ right: Eligible) -> Bool {
        if left.score != right.score { return left.score > right.score }
        if left.spreadBps != right.spreadBps { return left.spreadBps < right.spreadBps }
        if left.candidate.openInterest != right.candidate.openInterest {
            return (left.candidate.openInterest ?? 0) > (right.candidate.openInterest ?? 0)
        }
        if left.atmDistance != right.atmDistance { return left.atmDistance < right.atmDistance }
        return left.candidate.symbol < right.candidate.symbol
    }

    private static func summary(
        index: Int,
        rankings: [Eligible],
        exclusions: [AutoScoringExclusion],
        request: AutoScoringRequest,
        preferences: AutoScoringPreferences
    ) -> String {
        let item = rankings[index]
        if !exclusions.isEmpty, rankings.allSatisfy({ $0.score == rankings[0].score }) {
            return item.atmDistance == 0
                ? "Passes all hard filters at the ATM strike."
                : "Passes all hard filters within the strike window."
        }
        if rankings.count > 1, rankings.allSatisfy({ $0.score == rankings[0].score }) {
            let first = rankings[0]
            let second = rankings[1]
            if first.spreadBps != second.spreadBps {
                return index == 0 ? "Wins the score tie with the narrower spread." : "Loses the score tie on spread width."
            }
            if first.candidate.openInterest != second.candidate.openInterest {
                return index == 0
                    ? "Wins the score and spread tie with higher open interest."
                    : "Loses the tie on open interest."
            }
            if first.atmDistance != second.atmDistance {
                return index == 0 ? "Wins the remaining tie by being closer to ATM." : "Loses the remaining tie on ATM distance."
            }
            return index == 0 ? "Wins the final tie by contract symbol." : "Loses the final tie by contract symbol."
        }
        if preferences.gammaMode == .seek, request.optionType == .put {
            return index == 0
                ? "Matches absolute put delta and seeks higher absolute gamma."
                : "Lower absolute delta fit and gamma than the winner."
        }
        return item.normalized.delta == 1 && item.normalized.gamma == 1 && item.normalized.iv == 1
            ? "Closest to target delta with lower gamma and IV."
            : "Narrower spread and higher open interest."
    }

    private static func median(_ values: [Double]) -> Double {
        let sorted = values.sorted()
        let middle = sorted.count / 2
        return sorted.count.isMultiple(of: 2)
            ? (sorted[middle - 1] + sorted[middle]) / 2
            : sorted[middle]
    }

    private static func parseTimestamp(_ value: String) -> Date? {
        timestampFormatter.date(from: value)
    }

    private static func timestamp(_ date: Date) -> String {
        timestampFormatter.string(from: date)
    }

    private static let timestampFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private enum Dimension: CaseIterable {
        case delta, spread, openInterest, gamma, iv

        func value(from contributions: AutoScoringContributions) -> Double {
            switch self {
            case .delta: return contributions.delta
            case .spread: return contributions.spread
            case .openInterest: return contributions.openInterest
            case .gamma: return contributions.gamma
            case .iv: return contributions.iv
            }
        }

        func set(_ value: Double, on contributions: inout AutoScoringContributions) {
            switch self {
            case .delta: contributions.delta = value
            case .spread: contributions.spread = value
            case .openInterest: contributions.openInterest = value
            case .gamma: contributions.gamma = value
            case .iv: contributions.iv = value
            }
        }
    }
}

private extension AutoScoringContributions {
    var values: [Double] { [delta, spread, openInterest, gamma, iv] }
}
