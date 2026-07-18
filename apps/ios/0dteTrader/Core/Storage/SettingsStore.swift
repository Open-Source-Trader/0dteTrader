import Foundation

/// Trade screen layout (PRD FR-10/FR-11).
enum TradeLayout: String, Codable, CaseIterable, Sendable {
    /// Layout A — chart fills the screen, floating Buy/Sell buttons.
    case fullscreen
    /// Layout B — chart on top, trade panel in the bottom portion.
    case split
}

/// UserDefaults-backed app settings: layout choice, split fraction, indicator
/// presets, disclaimer acceptance, last symbol, FaceID lock toggle.
final class SettingsStore: @unchecked Sendable {
    private let defaults: UserDefaults
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private enum Keys {
        static let layoutMode = "settings.layoutMode"
        static let splitFraction = "settings.splitFraction"
        static let indicatorSettings = "settings.indicatorSettings"
        static let riskDisclaimerAccepted = "settings.riskDisclaimerAccepted"
        static let lastSymbol = "settings.lastSymbol"
        static let appLockEnabled = "settings.appLockEnabled"
    }

    /// Layout choice persists across launches (FR-12). Defaults to split view.
    var layoutMode: TradeLayout {
        get {
            defaults.string(forKey: Keys.layoutMode)
                .flatMap(TradeLayout.init(rawValue:)) ?? .split
        }
        set { defaults.set(newValue.rawValue, forKey: Keys.layoutMode) }
    }

    /// Trade panel height as a fraction of screen height, clamped so the panel
    /// always fits the trade ticket (floor 0.32, PRD ceiling 1/2).
    var splitFraction: Double {
        get {
            let stored = defaults.double(forKey: Keys.splitFraction)
            guard stored > 0 else { return 0.38 }
            return min(0.5, max(0.32, stored))
        }
        set { defaults.set(newValue, forKey: Keys.splitFraction) }
    }

    var indicatorSettings: IndicatorSettings {
        get {
            guard let data = defaults.data(forKey: Keys.indicatorSettings),
                  let settings = try? decoder.decode(IndicatorSettings.self, from: data)
            else {
                return .default
            }
            return settings
        }
        set {
            if let data = try? encoder.encode(newValue) {
                defaults.set(data, forKey: Keys.indicatorSettings)
            }
        }
    }

    var hasAcceptedRiskDisclaimer: Bool {
        get { defaults.bool(forKey: Keys.riskDisclaimerAccepted) }
        set { defaults.set(newValue, forKey: Keys.riskDisclaimerAccepted) }
    }

    var lastSymbol: String? {
        get { defaults.string(forKey: Keys.lastSymbol) }
        set { defaults.set(newValue, forKey: Keys.lastSymbol) }
    }

    var appLockEnabled: Bool {
        get { defaults.bool(forKey: Keys.appLockEnabled) }
        set { defaults.set(newValue, forKey: Keys.appLockEnabled) }
    }
}
