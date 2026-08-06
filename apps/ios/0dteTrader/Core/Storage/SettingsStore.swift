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
        static let indicatorSettingsV1 = "settings.indicatorSettings.v1"
        static let chartDisplayV1 = "settings.chartDisplay.v1"
        static let twcSettings = "settings.twcSettings"
        static let optionsAnalyticsSettings = "settings.optionsAnalytics.v1"
        static let chartTradingSettings = "settings.chartTrading.v1"
        static let riskDisclaimerAccepted = "settings.riskDisclaimerAccepted"
        static let lastSymbol = "settings.lastSymbol"
        static let appLockEnabled = "settings.appLockEnabled"
        static let tradingLocked = "settings.tradingLocked"
        static let bypassOrderConfirmation = "settings.bypassOrderConfirmation"
        static let toastsEnabled = "settings.toastsEnabled"
        static let pushNotificationsEnabled = "settings.pushNotificationsEnabled"
        static let pushDeviceToken = "settings.pushDeviceToken"
    }

    private struct LegacyIndicatorSettings: Decodable {
        let smaEnabled: Bool?
        let smaPeriod: Int?
        let emaEnabled: Bool?
        let emaPeriod: Int?
        let vwapEnabled: Bool?
        let rsiEnabled: Bool?
        let rsiPeriod: Int?
        let macdEnabled: Bool?
        let macdFastPeriod: Int?
        let macdSlowPeriod: Int?
        let macdSignalPeriod: Int?
        let bollingerEnabled: Bool?
        let bollingerPeriod: Int?
        let bollingerMultiplier: Double?
        let volumeEnabled: Bool?
        let stochEnabled: Bool?
        let stochKPeriod: Int?
        let stochKSmooth: Int?
        let stochDPeriod: Int?
        let atrEnabled: Bool?
        let atrPeriod: Int?
    }

    func loadIndicatorSettings(registry: IndicatorRegistry) throws -> IndicatorSettingsState {
        if let data = defaults.data(forKey: Keys.indicatorSettingsV1) {
            let state = try decoder.decode(IndicatorSettingsState.self, from: data)
            try IndicatorSettingsValidator.validate(state, registry: registry)
            try completeInterruptedMigration(state: state, registry: registry)
            return state
        }
        guard let legacyData = defaults.data(forKey: Keys.indicatorSettings) else {
            let state = try IndicatorSettingsState.defaults(for: registry)
            try persistIndicatorSettings(state)
            if defaults.data(forKey: Keys.chartDisplayV1) == nil {
                try persistChartDisplayPreferences(.default)
            }
            return state
        }

        let legacy = try decoder.decode(LegacyIndicatorSettings.self, from: legacyData)
        var state = try IndicatorSettingsState.defaults(for: registry)
        applyLegacy(legacy, to: &state)
        try IndicatorSettingsValidator.validate(state, registry: registry)

        let display = ChartDisplayPreferences(
            volumeEnabled: legacy.volumeEnabled ?? ChartDisplayPreferences.default.volumeEnabled,
            volumeWeightedCandleWidth: ChartDisplayPreferences.default.volumeWeightedCandleWidth
        )
        let previousSettingsData = defaults.data(forKey: Keys.indicatorSettingsV1)
        let previousDisplayData = defaults.data(forKey: Keys.chartDisplayV1)
        do {
            try persistIndicatorSettings(state)
            try persistChartDisplayPreferences(display)
            _ = try readBack(state: state, display: display, registry: registry)
        } catch {
            restore(previousSettingsData, forKey: Keys.indicatorSettingsV1)
            restore(previousDisplayData, forKey: Keys.chartDisplayV1)
            throw error
        }
        defaults.removeObject(forKey: Keys.indicatorSettings)
        return state
    }

    private func applyLegacy(_ legacy: LegacyIndicatorSettings, to state: inout IndicatorSettingsState) {
        apply(enabled: legacy.smaEnabled, parameters: ["period": legacy.smaPeriod], id: "sma", to: &state)
        apply(enabled: legacy.emaEnabled, parameters: ["period": legacy.emaPeriod], id: "ema", to: &state)
        apply(
            enabled: legacy.vwapEnabled,
            parameters: [String: Int?](),
            id: "anchored_vwap",
            to: &state
        )
        apply(enabled: legacy.rsiEnabled, parameters: ["period": legacy.rsiPeriod], id: "rsi", to: &state)
        apply(
            enabled: legacy.macdEnabled,
            parameters: [
                "fastPeriod": legacy.macdFastPeriod,
                "slowPeriod": legacy.macdSlowPeriod,
                "signalPeriod": legacy.macdSignalPeriod,
            ],
            id: "macd",
            to: &state
        )
        apply(
            enabled: legacy.bollingerEnabled,
            parameters: [
                "period": legacy.bollingerPeriod.map(Double.init),
                "multiplier": legacy.bollingerMultiplier,
            ],
            id: "bollinger",
            to: &state
        )
        apply(
            enabled: legacy.stochEnabled,
            parameters: [
                "kPeriod": legacy.stochKPeriod,
                "kSmooth": legacy.stochKSmooth,
                "dPeriod": legacy.stochDPeriod,
            ],
            id: "stochastic",
            to: &state
        )
        apply(enabled: legacy.atrEnabled, parameters: ["period": legacy.atrPeriod], id: "atr", to: &state)
    }

    private func apply(
        enabled: Bool?,
        parameters: [String: Int?],
        id: String,
        to state: inout IndicatorSettingsState
    ) {
        if let enabled { state.indicators[id]?.enabled = enabled }
        for (parameterId, value) in parameters {
            if let value { state.indicators[id]?.parameters[parameterId] = Double(value) }
        }
    }

    private func apply(
        enabled: Bool?,
        parameters: [String: Double?],
        id: String,
        to state: inout IndicatorSettingsState
    ) {
        if let enabled { state.indicators[id]?.enabled = enabled }
        for (parameterId, value) in parameters {
            if let value { state.indicators[id]?.parameters[parameterId] = value }
        }
    }

    private func completeInterruptedMigration(
        state: IndicatorSettingsState,
        registry: IndicatorRegistry
    ) throws {
        guard let legacyData = defaults.data(forKey: Keys.indicatorSettings) else { return }
        let previousDisplayData = defaults.data(forKey: Keys.chartDisplayV1)
        let display: ChartDisplayPreferences
        if let previousDisplayData,
           let decoded = try? decoder.decode(ChartDisplayPreferences.self, from: previousDisplayData) {
            display = decoded
        } else {
            let legacy = try? decoder.decode(LegacyIndicatorSettings.self, from: legacyData)
            display = ChartDisplayPreferences(
                volumeEnabled: legacy?.volumeEnabled ?? ChartDisplayPreferences.default.volumeEnabled,
                volumeWeightedCandleWidth: ChartDisplayPreferences.default.volumeWeightedCandleWidth
            )
            do {
                try persistChartDisplayPreferences(display)
            } catch {
                restore(previousDisplayData, forKey: Keys.chartDisplayV1)
                throw error
            }
        }
        do {
            _ = try readBack(state: state, display: display, registry: registry)
            defaults.removeObject(forKey: Keys.indicatorSettings)
        } catch {
            restore(previousDisplayData, forKey: Keys.chartDisplayV1)
            throw error
        }
    }

    func updateIndicatorSettings(_ candidate: IndicatorSettingsState, registry: IndicatorRegistry) throws {
        try IndicatorSettingsValidator.validate(candidate, registry: registry)
        try persistIndicatorSettings(candidate)
        let persisted = try decoder.decode(
            IndicatorSettingsState.self,
            from: defaults.data(forKey: Keys.indicatorSettingsV1) ?? Data()
        )
        try IndicatorSettingsValidator.validate(persisted, registry: registry)
        guard persisted == candidate else {
            throw IndicatorSettingsValidationError.invalid("Indicator settings could not be verified.")
        }
    }

    func loadChartDisplayPreferences() throws -> ChartDisplayPreferences {
        guard let data = defaults.data(forKey: Keys.chartDisplayV1) else { return .default }
        return try decoder.decode(ChartDisplayPreferences.self, from: data)
    }

    func updateChartDisplayPreferences(_ preferences: ChartDisplayPreferences) throws {
        try persistChartDisplayPreferences(preferences)
        let persisted = try decoder.decode(
            ChartDisplayPreferences.self,
            from: defaults.data(forKey: Keys.chartDisplayV1) ?? Data()
        )
        guard persisted == preferences else {
            throw IndicatorSettingsValidationError.invalid("Chart display settings could not be verified.")
        }
    }

    private func persistIndicatorSettings(_ state: IndicatorSettingsState) throws {
        defaults.set(try encoder.encode(state), forKey: Keys.indicatorSettingsV1)
    }

    private func persistChartDisplayPreferences(_ display: ChartDisplayPreferences) throws {
        defaults.set(try encoder.encode(display), forKey: Keys.chartDisplayV1)
    }

    private func restore(_ data: Data?, forKey key: String) {
        if let data {
            defaults.set(data, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }

    private func readBack(
        state: IndicatorSettingsState,
        display: ChartDisplayPreferences,
        registry: IndicatorRegistry
    ) throws -> Bool {
        guard let settingsData = defaults.data(forKey: Keys.indicatorSettingsV1),
              let displayData = defaults.data(forKey: Keys.chartDisplayV1)
        else {
            throw IndicatorSettingsValidationError.invalid("Migrated settings could not be read back.")
        }
        let savedState = try decoder.decode(IndicatorSettingsState.self, from: settingsData)
        let savedDisplay = try decoder.decode(ChartDisplayPreferences.self, from: displayData)
        try IndicatorSettingsValidator.validate(savedState, registry: registry)
        guard savedState == state, savedDisplay == display else {
            throw IndicatorSettingsValidationError.invalid("Migrated settings could not be verified.")
        }
        return true
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

    /// Push notifications for order events. Off until the user opts in.
    var pushNotificationsEnabled: Bool {
        get { defaults.bool(forKey: Keys.pushNotificationsEnabled) }
        set { defaults.set(newValue, forKey: Keys.pushNotificationsEnabled) }
    }

    /// The APNs token (lowercase hex) last uploaded to a given server, kept
    /// so a later DELETE can retry even after a relaunch. Keyed PER SERVER:
    /// the device token is device-scoped and may be registered with several
    /// backends at once, and each registration needs its own retry handle —
    /// a single shared slot loses the old server's handle on a server switch.
    func pushDeviceToken(server: String) -> String? {
        defaults.string(forKey: "\(Keys.pushDeviceToken).\(server)")
    }

    func setPushDeviceToken(_ token: String?, server: String) {
        let key = "\(Keys.pushDeviceToken).\(server)"
        if let token {
            defaults.set(token, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
}
