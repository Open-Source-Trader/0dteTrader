import Foundation

/// Settings for the GEX/DEX level overlay + premium heat map (gexSettings.ts
/// analog). Flat struct with decodeIfPresent migration, same pattern as
/// TwcHeatmapSettings.
struct GexSettings: Codable, Equatable, Sendable {
    /// Master toggle shown in the indicator list.
    var enabled: Bool
    /// Gamma flip / call wall / put wall / magnet lines + regime zone.
    var showLevels: Bool
    /// Premium heat map bands.
    var showPremium: Bool
    /// Poll interval for fresh Greeks (OI stays cached server-side).
    var refreshSeconds: Int
    /// How many premium strikes to render as bands.
    var maxPremiumStrikes: Int
    /// Alpha ceiling for the heaviest premium band.
    var opacityCap: Double

    static let `default` = GexSettings(
        enabled: false,
        showLevels: true,
        showPremium: true,
        refreshSeconds: 45,
        maxPremiumStrikes: 8,
        opacityCap: 0.55
    )

    static let refreshRange = 15...120
    static let heatStrikeRange = 3...10
}

// Decoding lives in an extension so the memberwise initializer stays available.
// decodeIfPresent keeps settings saved by older app versions valid.
extension GexSettings {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = GexSettings.default
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? d.enabled
        showLevels = try c.decodeIfPresent(Bool.self, forKey: .showLevels) ?? d.showLevels
        showPremium = try c.decodeIfPresent(Bool.self, forKey: .showPremium) ?? d.showPremium
        refreshSeconds = try c.decodeIfPresent(Int.self, forKey: .refreshSeconds) ?? d.refreshSeconds
        maxPremiumStrikes = try c.decodeIfPresent(Int.self, forKey: .maxPremiumStrikes) ?? d.maxPremiumStrikes
        opacityCap = try c.decodeIfPresent(Double.self, forKey: .opacityCap) ?? d.opacityCap
    }
}
