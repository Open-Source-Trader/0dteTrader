import Foundation

enum AutoScoringPreset: String, Codable, Sendable {
    case conservative
    case aggressive
    case custom
}

enum AutoSelectionStrategy: String, CaseIterable, Hashable, Sendable {
    case scored
    case classic
}

enum AutoScoringGammaMode: String, Codable, Sendable {
    case seek
    case avoid
}

struct AutoScoringContributions: Codable, Equatable, Sendable {
    var delta: Double
    var spread: Double
    var openInterest: Double
    var gamma: Double
    var iv: Double

    static let zero = AutoScoringContributions(
        delta: 0,
        spread: 0,
        openInterest: 0,
        gamma: 0,
        iv: 0
    )
}

typealias AutoScoringWeights = AutoScoringContributions

struct AutoScoringPreferences: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let preset: AutoScoringPreset
    let targetAbsDelta: Double
    let strikeRungs: Int
    let maxSpreadBps: Double
    let maxPremiumDollars: Double
    let minOpenInterest: Int
    let gammaMode: AutoScoringGammaMode
    let weights: AutoScoringWeights

    static let conservative = AutoScoringPreferences(
        schemaVersion: 1,
        preset: .conservative,
        targetAbsDelta: 0.25,
        strikeRungs: 5,
        maxSpreadBps: 500,
        maxPremiumDollars: 250,
        minOpenInterest: 100,
        gammaMode: .avoid,
        weights: AutoScoringWeights(delta: 0.3, spread: 0.25, openInterest: 0.2, gamma: 0.1, iv: 0.15)
    )

    static let aggressive = AutoScoringPreferences(
        schemaVersion: 1,
        preset: .aggressive,
        targetAbsDelta: 0.4,
        strikeRungs: 8,
        maxSpreadBps: 1_000,
        maxPremiumDollars: 500,
        minOpenInterest: 25,
        gammaMode: .seek,
        weights: AutoScoringWeights(delta: 0.25, spread: 0.15, openInterest: 0.15, gamma: 0.3, iv: 0.15)
    )
}

struct AutoScoringRequest: Codable, Equatable, Sendable {
    let underlying: String
    let expiration: String
    let optionType: OptionType
    let spot: Double
}

struct AutoScoringCandidate: Codable, Equatable, Sendable {
    let symbol: String
    let underlying: String
    let expiration: String
    let optionType: OptionType
    let strike: Double
    let bid: Double?
    let ask: Double?
    let delta: Double?
    let gamma: Double?
    let impliedVolatility: Double?
    let openInterest: Int?
    let quoteProvider: BrokerProvider
    let quoteTimestamp: String?
    let analyticsTimestamp: String?
}

enum AutoScoringExclusionReason: String, Codable, Equatable, Sendable {
    case wrongExpiration = "wrong_expiration"
    case wrongOptionType = "wrong_option_type"
    case outsideStrikeWindow = "outside_strike_window"
    case missingQuote = "missing_quote"
    case invalidQuote = "invalid_quote"
    case staleQuote = "stale_quote"
    case futureQuote = "future_quote"
    case missingDelta = "missing_delta"
    case missingGamma = "missing_gamma"
    case missingIV = "missing_iv"
    case missingOpenInterest = "missing_open_interest"
    case staleAnalytics = "stale_analytics"
    case deltaOutOfRange = "delta_out_of_range"
    case spreadTooWide = "spread_too_wide"
    case premiumTooHigh = "premium_too_high"
    case openInterestTooLow = "open_interest_too_low"
}

struct AutoScoringExclusion: Codable, Equatable, Sendable {
    let symbol: String
    let reason: AutoScoringExclusionReason
}

struct AutoScoringRationale: Codable, Equatable, Sendable {
    let summary: String
    let mid: Double
    let spreadBps: Double
    let premiumDollars: Double
    let atmDistance: Double
    let normalized: AutoScoringContributions
    let weighted: AutoScoringContributions
}

struct AutoScoringRanking: Codable, Equatable, Sendable {
    let rank: Int
    let candidate: AutoScoringCandidate
    let score: Double
    let rationale: AutoScoringRationale
}

struct AutoScoringResult: Codable, Equatable, Sendable {
    let rankings: [AutoScoringRanking]
    let exclusions: [AutoScoringExclusion]
    let selectedSymbol: String?
    let noPass: Bool
    let requiresConfirmation: Bool
    let rankedAt: String
}

struct AutoScoringRankRequest: Encodable, Equatable, Sendable {
    let underlying: String
    let expiration: String
    let optionType: OptionType
}

struct AutoScoringPreferenceRecord: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let preset: AutoScoringPreset
    let targetAbsDelta: Double
    let strikeRungs: Int
    let maxSpreadBps: Double
    let maxPremiumDollars: Double
    let minOpenInterest: Int
    let gammaMode: AutoScoringGammaMode
    let deltaWeight: Double
    let spreadWeight: Double
    let openInterestWeight: Double
    let gammaWeight: Double
    let ivWeight: Double
    let createdAt: String
    let updatedAt: String

    var preferences: AutoScoringPreferences {
        AutoScoringPreferences(
            schemaVersion: schemaVersion,
            preset: preset,
            targetAbsDelta: targetAbsDelta,
            strikeRungs: strikeRungs,
            maxSpreadBps: maxSpreadBps,
            maxPremiumDollars: maxPremiumDollars,
            minOpenInterest: minOpenInterest,
            gammaMode: gammaMode,
            weights: AutoScoringWeights(
                delta: deltaWeight,
                spread: spreadWeight,
                openInterest: openInterestWeight,
                gamma: gammaWeight,
                iv: ivWeight
            )
        )
    }
}

struct AutoScoringPreferenceUpdate: Encodable, Equatable, Sendable {
    let schemaVersion: Int
    let preset: AutoScoringPreset
    let targetAbsDelta: Double
    let strikeRungs: Int
    let maxSpreadBps: Double
    let maxPremiumDollars: Double
    let minOpenInterest: Int
    let gammaMode: AutoScoringGammaMode
    let deltaWeight: Double
    let spreadWeight: Double
    let openInterestWeight: Double
    let gammaWeight: Double
    let ivWeight: Double
    let expectedUpdatedAt: String

    init(preferences: AutoScoringPreferences, expectedUpdatedAt: String) {
        self.schemaVersion = preferences.schemaVersion
        self.preset = preferences.preset
        self.targetAbsDelta = preferences.targetAbsDelta
        self.strikeRungs = preferences.strikeRungs
        self.maxSpreadBps = preferences.maxSpreadBps
        self.maxPremiumDollars = preferences.maxPremiumDollars
        self.minOpenInterest = preferences.minOpenInterest
        self.gammaMode = preferences.gammaMode
        self.deltaWeight = preferences.weights.delta
        self.spreadWeight = preferences.weights.spread
        self.openInterestWeight = preferences.weights.openInterest
        self.gammaWeight = preferences.weights.gamma
        self.ivWeight = preferences.weights.iv
        self.expectedUpdatedAt = expectedUpdatedAt
    }
}

struct AutoScoringSelectionDTO: Encodable, Equatable, Sendable {
    let selectedSymbol: String
    let preferences: AutoScoringPreferences
    let scoredConfirmationAccepted: Bool
    let rankedAt: String
}
