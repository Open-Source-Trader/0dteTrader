import Foundation
import XCTest
@testable import ZeroDTETrader

final class IndicatorRegistryTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUpWithError() throws {
        suiteName = "IndicatorRegistryTests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
    }

    func testBundledRegistryDecodesCanonicalContract() throws {
        let registry = try IndicatorRegistry.bundled()

        XCTAssertEqual(registry.version, 1)
        XCTAssertEqual(registry.maxSubPanes, 2)
        XCTAssertEqual(registry.paneLimitMessage, "You can display up to 2 indicator panes.")
        XCTAssertEqual(registry.indicators.filter { !$0.requiresL2 }.count, 16)
        XCTAssertEqual(Set(registry.indicators.map(\.geometry.kind.rawValue)), Set([
            "line", "multi_line", "band", "cloud", "histogram", "segmented_line", "price_profile",
        ]))
        XCTAssertEqual(Set(registry.indicators.map(\.id)).count, registry.indicators.count)
    }

    func testDefaultsAreKeyedByEveryRegistryIdentifierAndL2IsDisabled() throws {
        let registry = try IndicatorRegistry.bundled()
        let state = try IndicatorSettingsState.defaults(for: registry)

        XCTAssertEqual(Set(state.indicators.keys), Set(registry.indicators.map(\.id)))
        for descriptor in registry.indicators where descriptor.requiresL2 {
            XCTAssertEqual(state.indicators[descriptor.id]?.enabled, false)
        }
        XCTAssertEqual(try XCTUnwrap(state.indicators["ema"]).parameters["period"], 9)
        XCTAssertEqual(try XCTUnwrap(state.indicators["anchored_vwap"]).parameters["anchorTimestamp"], 0)
        let encoded = try XCTUnwrap(String(data: JSONEncoder().encode(state), encoding: .utf8))
        XCTAssertTrue(encoded.contains("\"registryVersion\":1"))
        XCTAssertFalse(encoded.contains("\"version\":"))
    }

    func testLegacyMigrationIsAtomicIdempotentAndMovesVolumePreference() throws {
        let legacy: [String: Any] = [
            "smaEnabled": true, "smaPeriod": 30,
            "emaEnabled": false, "emaPeriod": 12,
            "vwapEnabled": true,
            "rsiEnabled": true, "rsiPeriod": 9,
            "macdEnabled": false,
            "bollingerEnabled": true, "bollingerPeriod": 25, "bollingerMultiplier": 2.5,
            "volumeEnabled": false,
            "stochEnabled": false, "stochKPeriod": 10, "stochKSmooth": 2, "stochDPeriod": 4,
            "atrEnabled": false, "atrPeriod": 10,
        ]
        defaults.set(try JSONSerialization.data(withJSONObject: legacy), forKey: "settings.indicatorSettings")

        let registry = try IndicatorRegistry.bundled()
        let store = SettingsStore(defaults: defaults)
        let first = try store.loadIndicatorSettings(registry: registry)

        XCTAssertEqual(first.indicators["sma"], .init(enabled: true, parameters: ["period": 30]))
        XCTAssertEqual(first.indicators["anchored_vwap"], .init(enabled: true, parameters: ["anchorTimestamp": 0]))
        XCTAssertEqual(first.indicators["macd"]?.parameters, ["fastPeriod": 12, "slowPeriod": 26, "signalPeriod": 9])
        XCTAssertEqual(try store.loadChartDisplayPreferences().volumeEnabled, false)
        XCTAssertNil(defaults.object(forKey: "settings.indicatorSettings"))
        XCTAssertNotNil(defaults.data(forKey: "settings.indicatorSettings.v1"))
        XCTAssertNotNil(defaults.data(forKey: "settings.chartDisplay.v1"))

        let persisted = defaults.data(forKey: "settings.indicatorSettings.v1")
        XCTAssertEqual(try store.loadIndicatorSettings(registry: registry), first)
        XCTAssertEqual(defaults.data(forKey: "settings.indicatorSettings.v1"), persisted)
    }

    func testPartialLegacyMigrationUsesRegistryDefaultsAndPreservesExactMacdPeriods() throws {
        let legacy: [String: Any] = [
            "emaEnabled": false,
            "macdEnabled": true,
            "macdFastPeriod": 4,
            "macdSlowPeriod": 8,
            "macdSignalPeriod": 3,
        ]
        defaults.set(try JSONSerialization.data(withJSONObject: legacy), forKey: "settings.indicatorSettings")

        let registry = try IndicatorRegistry.bundled()
        let state = try SettingsStore(defaults: defaults).loadIndicatorSettings(registry: registry)

        XCTAssertEqual(state.indicators["sma"], registry.descriptor(id: "sma")?.defaultSettings)
        XCTAssertEqual(state.indicators["ema"], .init(enabled: false, parameters: ["period": 9]))
        XCTAssertEqual(state.indicators["macd"], .init(
            enabled: true,
            parameters: ["fastPeriod": 4, "slowPeriod": 8, "signalPeriod": 3]
        ))
    }

    func testValidCurrentSettingsCompleteInterruptedMigrationAndRemoveLegacyResidue() throws {
        let registry = try IndicatorRegistry.bundled()
        let store = SettingsStore(defaults: defaults)
        let current = try store.loadIndicatorSettings(registry: registry)
        defaults.removeObject(forKey: "settings.chartDisplay.v1")
        defaults.set(
            try JSONSerialization.data(withJSONObject: ["volumeEnabled": false]),
            forKey: "settings.indicatorSettings"
        )

        XCTAssertEqual(try store.loadIndicatorSettings(registry: registry), current)
        XCTAssertEqual(try store.loadChartDisplayPreferences(), .init(volumeEnabled: false))
        XCTAssertNil(defaults.data(forKey: "settings.indicatorSettings"))
    }

    func testFailedLegacyMigrationPreservesLegacyAndWritesNoPartialState() throws {
        defaults.set(Data("not-json".utf8), forKey: "settings.indicatorSettings")
        let store = SettingsStore(defaults: defaults)

        XCTAssertThrowsError(try store.loadIndicatorSettings(registry: IndicatorRegistry.bundled()))
        XCTAssertNotNil(defaults.data(forKey: "settings.indicatorSettings"))
        XCTAssertNil(defaults.data(forKey: "settings.indicatorSettings.v1"))
        XCTAssertNil(defaults.data(forKey: "settings.chartDisplay.v1"))
    }

    func testValidationRejectsUnknownParametersNonfiniteBoundsConstraintsAndThirdPane() throws {
        let registry = try IndicatorRegistry.bundled()
        let valid = try IndicatorSettingsState.defaults(for: registry)

        var unknown = valid
        unknown.indicators["unknown"] = .init(enabled: false, parameters: [:])
        XCTAssertThrowsError(try IndicatorSettingsValidator.validate(unknown, registry: registry))

        var unknownParameter = valid
        unknownParameter.indicators["sma"]?.parameters["mystery"] = 3
        XCTAssertThrowsError(try IndicatorSettingsValidator.validate(unknownParameter, registry: registry))

        var nonfinite = valid
        nonfinite.indicators["sma"]?.parameters["period"] = .nan
        XCTAssertThrowsError(try IndicatorSettingsValidator.validate(nonfinite, registry: registry))

        var outOfRange = valid
        outOfRange.indicators["sma"]?.parameters["period"] = 501
        XCTAssertThrowsError(try IndicatorSettingsValidator.validate(outOfRange, registry: registry))

        var invalidConstraint = valid
        invalidConstraint.indicators["macd"] = .init(
            enabled: true,
            parameters: ["fastPeriod": 26, "slowPeriod": 12, "signalPeriod": 9]
        )
        XCTAssertThrowsError(try IndicatorSettingsValidator.validate(invalidConstraint, registry: registry))

        var tooManyPanes = valid
        for id in ["rsi", "macd", "atr"] { tooManyPanes.indicators[id]?.enabled = true }
        XCTAssertThrowsError(try IndicatorSettingsValidator.validate(tooManyPanes, registry: registry)) { error in
            XCTAssertEqual(error.localizedDescription, registry.paneLimitMessage)
        }
    }

    func testStoreRejectsInvalidMutationAndPreservesLastValidState() throws {
        let registry = try IndicatorRegistry.bundled()
        let store = SettingsStore(defaults: defaults)
        let original = try store.loadIndicatorSettings(registry: registry)
        var invalid = original
        for id in ["rsi", "macd", "atr"] { invalid.indicators[id]?.enabled = true }

        XCTAssertThrowsError(try store.updateIndicatorSettings(invalid, registry: registry))
        XCTAssertEqual(try store.loadIndicatorSettings(registry: registry), original)
    }

    func testTickStorageCodecDecodesOldIntegerVolumeAndRoundTripsDoubleVolume() throws {
        let legacy = Data("""
        {"candles":[{"time":100,"open":10,"high":12,"low":9,"close":11,"volume":123}],"accumulator":null}
        """.utf8)

        let decoded = try TickStorageCodec.decode(legacy)
        XCTAssertEqual(decoded.candles.first?.volume, 123)

        let state = StoredTickState(
            candles: [Candle(
                time: Date(timeIntervalSince1970: 200),
                open: 20,
                high: 22,
                low: 19,
                close: 21,
                volume: 123.75
            )],
            accumulator: nil
        )
        let roundTripped = try TickStorageCodec.decode(TickStorageCodec.encode(state))

        XCTAssertEqual(roundTripped.candles, state.candles)
        XCTAssertEqual(roundTripped.candles.first?.volume, 123.75)
    }
}
