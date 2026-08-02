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
        static let twcSettings = "settings.twcSettings"
        static let optionsAnalyticsSettings = "settings.optionsAnalytics.v1"
        static let chartTradingSettings = "settings.chartTrading.v1"
        static let riskDisclaimerAccepted = "settings.riskDisclaimerAccepted"
        static let lastSymbol = "settings.lastSymbol"
        static let appLockEnabled = "settings.appLockEnabled"
        static let tradingLocked = "settings.tradingLocked"
        static let bypassOrderConfirmation = "settings.bypassOrderConfirmation"
        static let autoOtmOffset = "settings.autoOtmOffset"
        static let toastsEnabled = "settings.toastsEnabled"
        static let pushNotificationsEnabled = "settings.pushNotificationsEnabled"
        static let pushDeviceToken = "settings.pushDeviceToken"
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

    var twcSettings: TwcHeatmapSettings {
        get {
            guard let data = defaults.data(forKey: Keys.twcSettings),
                  let settings = try? decoder.decode(TwcHeatmapSettings.self, from: data)
            else {
                return .default
            }
            return settings
        }
        set {
            if let data = try? encoder.encode(newValue) {
                defaults.set(data, forKey: Keys.twcSettings)
            }
        }
    }

    var optionsAnalyticsSettings: OptionsAnalyticsSettings {
        get {
            guard let data = defaults.data(forKey: Keys.optionsAnalyticsSettings),
                  let settings = try? decoder.decode(OptionsAnalyticsSettings.self, from: data)
            else {
                return .default
            }
            return settings
        }
        set {
            if let data = try? encoder.encode(newValue) {
                defaults.set(data, forKey: Keys.optionsAnalyticsSettings)
            }
        }
    }

    /// Chart trading (order lines drawn directly on the candles).
    var chartTradingSettings: ChartTradingSettings {
        get {
            guard let data = defaults.data(forKey: Keys.chartTradingSettings),
                  let settings = try? decoder.decode(ChartTradingSettings.self, from: data)
            else {
                return .default
            }
            return settings
        }
        set {
            if let data = try? encoder.encode(newValue) {
                defaults.set(data, forKey: Keys.chartTradingSettings)
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

    /// Trading lock: when true, every order-placing control is disabled. Persists
    /// across launches (the lock is remembered, like the layout choice). Distinct
    /// from `appLockEnabled`, which is the Face-ID app-open gate.
    var tradingLocked: Bool {
        get { defaults.bool(forKey: Keys.tradingLocked) }
        set { defaults.set(newValue, forKey: Keys.tradingLocked) }
    }

    /// Skip the buy/sell confirmation sheet and submit immediately. Per-device.
    var bypassOrderConfirmation: Bool {
        get { defaults.bool(forKey: Keys.bypassOrderConfirmation) }
        set { defaults.set(newValue, forKey: Keys.bypassOrderConfirmation) }
    }

    /// Success/info toast banners (default on). Gates those styles only —
    /// error toasts always show.
    var toastsEnabled: Bool {
        get {
            guard defaults.object(forKey: Keys.toastsEnabled) != nil else { return true }
            return defaults.bool(forKey: Keys.toastsEnabled)
        }
        set { defaults.set(newValue, forKey: Keys.toastsEnabled) }
    }

    /// AUTO mode's OTM preference: strikes beyond the ATM anchor (0 = ATM,
    /// default 1). Clamped on read so a stale or hand-edited value can never
    /// walk AUTO off the strike ladder.
    var autoOtmOffset: Int {
        get {
            guard defaults.object(forKey: Keys.autoOtmOffset) != nil else { return 1 }
            return min(10, max(0, defaults.integer(forKey: Keys.autoOtmOffset)))
        }
        set { defaults.set(newValue, forKey: Keys.autoOtmOffset) }
    }

    /// Push notifications for order events. Off until the user opts in.
    var pushNotificationsEnabled: Bool {
        get { defaults.bool(forKey: Keys.pushNotificationsEnabled) }
        set { defaults.set(newValue, forKey: Keys.pushNotificationsEnabled) }
    }

    /// The APNs token (lowercase hex) last uploaded to the server, kept so
    /// disabling can DELETE it even after a relaunch.
    var pushDeviceToken: String? {
        get { defaults.string(forKey: Keys.pushDeviceToken) }
        set { defaults.set(newValue, forKey: Keys.pushDeviceToken) }
    }
}
