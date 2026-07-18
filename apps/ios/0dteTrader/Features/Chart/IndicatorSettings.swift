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
    var volumeEnabled: Bool
    var stochEnabled: Bool
    var stochKPeriod: Int
    var stochKSmooth: Int
    var stochDPeriod: Int
    var atrEnabled: Bool
    var atrPeriod: Int

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
        bollingerMultiplier: 2,
        volumeEnabled: true,
        stochEnabled: false,
        stochKPeriod: 14,
        stochKSmooth: 3,
        stochDPeriod: 3,
        atrEnabled: false,
        atrPeriod: 14
    )
}

/// Parameter ranges owned by the model so views don't carry magic numbers.
extension IndicatorSettings {
    static let maPeriodRange = 2...200
    static let bollingerPeriodRange = 5...100
    static let bollingerMultiplierRange = 0.5...4.0
    static let oscillatorPeriodRange = 2...50
    static let stochKPeriodRange = 5...50
    static let stochSmoothRange = 1...10
}

// Decoding lives in an extension so the memberwise initializer stays available.
// decodeIfPresent keeps settings saved by older app versions valid.
extension IndicatorSettings {
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let defaults = IndicatorSettings.default
        smaEnabled = try container.decodeIfPresent(Bool.self, forKey: .smaEnabled) ?? defaults.smaEnabled
        smaPeriod = try container.decodeIfPresent(Int.self, forKey: .smaPeriod) ?? defaults.smaPeriod
        emaEnabled = try container.decodeIfPresent(Bool.self, forKey: .emaEnabled) ?? defaults.emaEnabled
        emaPeriod = try container.decodeIfPresent(Int.self, forKey: .emaPeriod) ?? defaults.emaPeriod
        vwapEnabled = try container.decodeIfPresent(Bool.self, forKey: .vwapEnabled) ?? defaults.vwapEnabled
        rsiEnabled = try container.decodeIfPresent(Bool.self, forKey: .rsiEnabled) ?? defaults.rsiEnabled
        rsiPeriod = try container.decodeIfPresent(Int.self, forKey: .rsiPeriod) ?? defaults.rsiPeriod
        macdEnabled = try container.decodeIfPresent(Bool.self, forKey: .macdEnabled) ?? defaults.macdEnabled
        bollingerEnabled = try container.decodeIfPresent(Bool.self, forKey: .bollingerEnabled) ?? defaults.bollingerEnabled
        bollingerPeriod = try container.decodeIfPresent(Int.self, forKey: .bollingerPeriod) ?? defaults.bollingerPeriod
        bollingerMultiplier = try container.decodeIfPresent(Double.self, forKey: .bollingerMultiplier) ?? defaults.bollingerMultiplier
        volumeEnabled = try container.decodeIfPresent(Bool.self, forKey: .volumeEnabled) ?? defaults.volumeEnabled
        stochEnabled = try container.decodeIfPresent(Bool.self, forKey: .stochEnabled) ?? defaults.stochEnabled
        stochKPeriod = try container.decodeIfPresent(Int.self, forKey: .stochKPeriod) ?? defaults.stochKPeriod
        stochKSmooth = try container.decodeIfPresent(Int.self, forKey: .stochKSmooth) ?? defaults.stochKSmooth
        stochDPeriod = try container.decodeIfPresent(Int.self, forKey: .stochDPeriod) ?? defaults.stochDPeriod
        atrEnabled = try container.decodeIfPresent(Bool.self, forKey: .atrEnabled) ?? defaults.atrEnabled
        atrPeriod = try container.decodeIfPresent(Int.self, forKey: .atrPeriod) ?? defaults.atrPeriod
    }
}
