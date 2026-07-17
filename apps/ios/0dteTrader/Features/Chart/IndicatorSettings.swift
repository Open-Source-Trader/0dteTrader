import Foundation

/// User-configurable indicator presets, persisted in SettingsStore (PRD FR-7).
struct IndicatorSettings: Codable, Equatable, Sendable {
    var smaEnabled: Bool
    var smaPeriod: Int
    var emaEnabled: Bool
    var emaPeriod: Int
    var vwapEnabled: Bool
    var rsiEnabled: Bool
    var rsiPeriod: Int
    var macdEnabled: Bool
    var bollingerEnabled: Bool
    var bollingerPeriod: Int
    var bollingerMultiplier: Double

    static let `default` = IndicatorSettings(
        smaEnabled: false,
        smaPeriod: 20,
        emaEnabled: true,
        emaPeriod: 9,
        vwapEnabled: true,
        rsiEnabled: false,
        rsiPeriod: 14,
        macdEnabled: false,
        bollingerEnabled: false,
        bollingerPeriod: 20,
        bollingerMultiplier: 2
    )
}
