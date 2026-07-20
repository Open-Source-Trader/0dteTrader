import Foundation

struct OptionsAnalyticsSettings: Codable, Equatable, Sendable {
    var enabled: Bool
    var showImpliedRange: Bool
    var showGammaProfile: Bool
    var showMarkedOi: Bool
    var showLiquidity: Bool
    var showDealerProxy: Bool
    var refreshSeconds: Int
    var profileStrikeCount: Int
    var showDiagnostics: Bool

    static let refreshRange = 15...120
    static let profileStrikeRange = 3...20

    static let `default` = OptionsAnalyticsSettings(
        enabled: true,
        showImpliedRange: true,
        showGammaProfile: true,
        showMarkedOi: false,
        showLiquidity: false,
        showDealerProxy: false,
        refreshSeconds: 45,
        profileStrikeCount: 12,
        showDiagnostics: true
    )

    init(
        enabled: Bool,
        showImpliedRange: Bool,
        showGammaProfile: Bool,
        showMarkedOi: Bool,
        showLiquidity: Bool,
        showDealerProxy: Bool,
        refreshSeconds: Int,
        profileStrikeCount: Int,
        showDiagnostics: Bool
    ) {
        self.enabled = enabled
        self.showImpliedRange = showImpliedRange
        self.showGammaProfile = showGammaProfile
        self.showMarkedOi = showMarkedOi
        self.showLiquidity = showLiquidity
        self.showDealerProxy = showDealerProxy
        self.refreshSeconds = Self.refreshRange.clamped(refreshSeconds)
        self.profileStrikeCount = Self.profileStrikeRange.clamped(profileStrikeCount)
        self.showDiagnostics = showDiagnostics
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let defaults = Self.default
        self.init(
            enabled: try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? defaults.enabled,
            showImpliedRange: try container.decodeIfPresent(Bool.self, forKey: .showImpliedRange)
                ?? defaults.showImpliedRange,
            showGammaProfile: try container.decodeIfPresent(Bool.self, forKey: .showGammaProfile)
                ?? defaults.showGammaProfile,
            showMarkedOi: try container.decodeIfPresent(Bool.self, forKey: .showMarkedOi)
                ?? defaults.showMarkedOi,
            showLiquidity: try container.decodeIfPresent(Bool.self, forKey: .showLiquidity)
                ?? defaults.showLiquidity,
            showDealerProxy: try container.decodeIfPresent(Bool.self, forKey: .showDealerProxy)
                ?? defaults.showDealerProxy,
            refreshSeconds: try container.decodeIfPresent(Int.self, forKey: .refreshSeconds)
                ?? defaults.refreshSeconds,
            profileStrikeCount: try container.decodeIfPresent(Int.self, forKey: .profileStrikeCount)
                ?? defaults.profileStrikeCount,
            showDiagnostics: try container.decodeIfPresent(Bool.self, forKey: .showDiagnostics)
                ?? defaults.showDiagnostics
        )
    }
}

private extension ClosedRange where Bound == Int {
    func clamped(_ value: Int) -> Int {
        min(upperBound, max(lowerBound, value))
    }
}
