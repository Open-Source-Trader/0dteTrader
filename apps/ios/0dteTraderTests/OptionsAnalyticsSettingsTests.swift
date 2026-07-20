import XCTest
@testable import ZeroDTETrader

final class OptionsAnalyticsSettingsTests: XCTestCase {
    func testDefaultsExposeFactsAndHideOptionalAssumptionLayers() {
        let settings = OptionsAnalyticsSettings.default

        XCTAssertTrue(settings.enabled)
        XCTAssertTrue(settings.showImpliedRange)
        XCTAssertTrue(settings.showGammaProfile)
        XCTAssertFalse(settings.showMarkedOi)
        XCTAssertFalse(settings.showLiquidity)
        XCTAssertFalse(settings.showDealerProxy)
        XCTAssertEqual(settings.refreshSeconds, 45)
        XCTAssertEqual(settings.profileStrikeCount, 12)
    }

    func testDecodedValuesClampToSupportedRanges() throws {
        let tooLow = try JSONDecoder().decode(
            OptionsAnalyticsSettings.self,
            from: Data("{\"refreshSeconds\":1,\"profileStrikeCount\":1}".utf8)
        )
        XCTAssertEqual(tooLow.refreshSeconds, 15)
        XCTAssertEqual(tooLow.profileStrikeCount, 3)

        let tooHigh = try JSONDecoder().decode(
            OptionsAnalyticsSettings.self,
            from: Data("{\"refreshSeconds\":999,\"profileStrikeCount\":999}".utf8)
        )
        XCTAssertEqual(tooHigh.refreshSeconds, 120)
        XCTAssertEqual(tooHigh.profileStrikeCount, 20)
    }

    func testStoreUsesVersionedKeyAndIgnoresUnversionedLegacyKey() throws {
        let suite = "OptionsAnalyticsSettingsTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let legacyKey = "settings." + ["g", "exSettings"].joined()
        defaults.set(Data("{\"enabled\":true}".utf8), forKey: legacyKey)
        let store = SettingsStore(defaults: defaults)

        XCTAssertTrue(store.optionsAnalyticsSettings.enabled)

        var settings = OptionsAnalyticsSettings.default
        settings.enabled = true
        store.optionsAnalyticsSettings = settings
        XCTAssertNotNil(defaults.data(forKey: "settings.optionsAnalytics.v1"))
        XCTAssertTrue(store.optionsAnalyticsSettings.enabled)
    }
}
