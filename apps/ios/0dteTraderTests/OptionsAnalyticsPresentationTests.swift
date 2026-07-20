// swiftlint:disable line_length
import XCTest
@testable import ZeroDTETrader

final class OptionsAnalyticsPresentationTests: XCTestCase {
    func testNotionalSuffixesAreCorrect() {
        XCTAssertEqual(OptionsAnalyticsPresentation.notionalText(1_250_000_000), "+$1.3B")
        XCTAssertEqual(OptionsAnalyticsPresentation.notionalText(-800_000_000), "-$800.0M")
        XCTAssertEqual(OptionsAnalyticsPresentation.notionalText(42_000_000), "+$42.0M")
        XCTAssertEqual(OptionsAnalyticsPresentation.notionalText(5_200), "+$5K")
        XCTAssertEqual(OptionsAnalyticsPresentation.notionalText(0), "$0")
    }

    func testMagnitudeFractionUsesStableSquareRootScale() {
        XCTAssertEqual(OptionsAnalyticsPresentation.magnitudeFraction(value: 0, maximum: 100), 0)
        XCTAssertEqual(OptionsAnalyticsPresentation.magnitudeFraction(value: 25, maximum: 100), 0.5, accuracy: 1e-12)
        XCTAssertEqual(OptionsAnalyticsPresentation.magnitudeFraction(value: -100, maximum: 100), 1, accuracy: 1e-12)
        XCTAssertEqual(OptionsAnalyticsPresentation.magnitudeFraction(value: 200, maximum: 100), 1, accuracy: 1e-12)
        XCTAssertEqual(OptionsAnalyticsPresentation.magnitudeFraction(value: 10, maximum: 0), 0)
    }

    func testProfileScalesNormalizeAgainstAllSnapshotStrikes() throws {
        let smaller = makeLeg(gammaExposure: 25, markedOiValue: 400)
        let larger = makeLeg(gammaExposure: 100, markedOiValue: 1_600)
        let smallerGammaExposure = try XCTUnwrap(smaller.gammaExposure)
        let strikes = [
            makeStrike(strike: 580, call: smaller, put: nil),
            makeStrike(strike: 585, call: nil, put: larger),
        ]

        let maxima = OptionsAnalyticsPresentation.profileNormalization(for: strikes)

        XCTAssertEqual(maxima.gammaExposure, 100)
        XCTAssertEqual(maxima.markedOiValue, 1_600)
        XCTAssertEqual(
            OptionsAnalyticsPresentation.magnitudeFraction(
                value: smallerGammaExposure,
                maximum: maxima.gammaExposure
            ),
            0.5,
            accuracy: 1e-12
        )
        XCTAssertEqual(
            OptionsAnalyticsPresentation.magnitudeFraction(
                value: smaller.markedOiValue!,
                maximum: maxima.markedOiValue
            ),
            0.5,
            accuracy: 1e-12
        )
    }

    func testCombinedLayersRetainLowGammaHighOiStrike() throws {
        let snapshot = try JSONDecoder().decode(
            OptionsAnalyticsSnapshotDTO.self,
            from: Data(OptionsAnalyticsContractTests.fixtureForPresentation.utf8)
        )
        let strikes = [
            makeStrike(strike: 580, call: makeLeg(gammaExposure: 100, markedOiValue: 10), put: nil),
            makeStrike(strike: 581, call: makeLeg(gammaExposure: 90, markedOiValue: 20), put: nil),
            makeStrike(strike: 582, call: makeLeg(gammaExposure: 80, markedOiValue: 30), put: nil),
            makeStrike(strike: 583, call: makeLeg(gammaExposure: 1, markedOiValue: 1_000), put: nil),
        ]
        var settings = OptionsAnalyticsSettings.default
        settings.showGammaProfile = true
        settings.showMarkedOi = true
        settings.profileStrikeCount = 3

        let selected = OptionsAnalyticsPresentation.selectedProfileStrikes(
            strikes: strikes,
            spot: snapshot.scope.spot,
            settings: settings
        )

        XCTAssertEqual(Set(selected.map(\.strike)), Set([580, 581, 583]))
    }

    func testCombinedLayersRetainLowGammaLiquidityImportantVisibleStrike() {
        let strikes = [
            makeStrike(strike: 580, call: makeLeg(gammaExposure: 1_000, markedOiValue: nil), put: nil),
            makeStrike(strike: 581, call: makeLeg(gammaExposure: 900, markedOiValue: nil), put: nil),
            makeStrike(
                strike: 583,
                call: makeLeg(gammaExposure: 1, markedOiValue: nil, volume: 10_000),
                put: nil
            ),
        ]
        var settings = OptionsAnalyticsSettings.default
        settings.showGammaProfile = true
        settings.showMarkedOi = false
        settings.showLiquidity = true
        settings.profileStrikeCount = 2

        let selected = OptionsAnalyticsPresentation.selectedProfileStrikes(
            strikes: strikes,
            spot: 580,
            settings: settings,
            isVisible: { _ in true }
        )

        XCTAssertEqual(selected.map(\.strike), [580, 583])
    }

    func testLiquidityImportanceNormalizesFiveFullSnapshotMetricsIndependently() {
        let strikes = [
            makeStrike(strike: 580, call: makeLeg(gammaExposure: 0, markedOiValue: nil), put: nil),
            makeStrike(
                strike: 581,
                call: makeLeg(
                    gammaExposure: 0,
                    markedOiValue: nil,
                    bidSize: 1_000,
                    askSize: 1_000
                ),
                put: nil
            ),
            makeStrike(
                strike: 582,
                call: makeLeg(gammaExposure: 0, markedOiValue: nil, openInterest: 1_000),
                put: nil
            ),
            makeStrike(
                strike: 583,
                call: makeLeg(gammaExposure: 0, markedOiValue: nil, volume: 1_000),
                put: nil
            ),
            makeStrike(
                strike: 584,
                call: makeLeg(gammaExposure: 0, markedOiValue: nil, relativeSpread: 0.5),
                put: nil
            ),
            makeStrike(
                strike: 585,
                call: makeLeg(gammaExposure: 0, markedOiValue: nil, roundTripCost: 1_000),
                put: nil
            ),
        ]
        var settings = OptionsAnalyticsSettings.default
        settings.showGammaProfile = false
        settings.showMarkedOi = false
        settings.showLiquidity = true
        settings.profileStrikeCount = 5

        let selected = OptionsAnalyticsPresentation.selectedProfileStrikes(
            strikes: strikes,
            spot: 580,
            settings: settings
        )

        XCTAssertEqual(selected.map(\.strike), [581, 582, 583, 584, 585])
    }

    func testProfileSelectionAppliesPaneVisibilityBeforeStrikeLimit() {
        let strikes = [
            makeStrike(strike: 580, call: makeLeg(gammaExposure: 1_000, markedOiValue: 10), put: nil),
            makeStrike(strike: 581, call: makeLeg(gammaExposure: 90, markedOiValue: 20), put: nil),
            makeStrike(strike: 582, call: makeLeg(gammaExposure: 80, markedOiValue: 30), put: nil),
            makeStrike(strike: 583, call: makeLeg(gammaExposure: 70, markedOiValue: 40), put: nil),
        ]
        var settings = OptionsAnalyticsSettings.default
        settings.profileStrikeCount = 3

        let selected = OptionsAnalyticsPresentation.selectedProfileStrikes(
            strikes: strikes,
            spot: 581.5,
            settings: settings,
            isVisible: { $0.strike != 580 }
        )

        XCTAssertEqual(selected.map(\.strike), [581, 582, 583])
    }

    func testLegDetailsExposeDecisionLiquidityInputs() {
        let leg = makeLeg(
            gammaExposure: 25,
            markedOiValue: 144_000,
            relativeSpread: 0.04,
            roundTripCost: 8,
            openInterest: 1_200,
            volume: 210,
            bidSize: 31,
            askSize: 27
        )

        let details = Dictionary(
            uniqueKeysWithValues: OptionsAnalyticsPresentation.legDetails(side: "Call", leg: leg)
                .map { ($0.label, $0.value) }
        )

        XCTAssertEqual(details["Call open interest"], "1200")
        XCTAssertEqual(details["Call volume"], "210")
        XCTAssertEqual(details["Call quote sizes"], "31 bid / 27 ask")
        XCTAssertEqual(details["Call relative spread"], "4.0%")
        XCTAssertEqual(details["Call per-contract round trip"], "$8.00")
    }

    func testLegDetailsExposeLocalGreeksAndNotionalsWithUnits() {
        let leg = makeLeg(
            gammaExposure: 110_000,
            markedOiValue: nil,
            impliedVolatility: 0.2,
            delta: -0.48,
            gamma: 0.03,
            deltaNotional: -29_100_000
        )

        let details = Dictionary(
            uniqueKeysWithValues: OptionsAnalyticsPresentation.legDetails(side: "Put", leg: leg)
                .map { ($0.label, $0.value) }
        )

        XCTAssertEqual(details["Put implied volatility"], "20.0%")
        XCTAssertEqual(details["Put delta"], "-0.4800")
        XCTAssertEqual(details["Put gamma per $1 move"], "0.030000")
        XCTAssertEqual(details["Put gamma exposure per 1% move"], "+$110K")
        XCTAssertEqual(details["Put delta notional"], "-$29.1M")
    }

    func testRailWidthClampsToTwentyEightPercentBetweenFiftySixAndOneTwelve() {
        XCTAssertEqual(OptionsAnalyticsPresentation.railWidth(for: 120), 56)
        XCTAssertEqual(OptionsAnalyticsPresentation.railWidth(for: 300), 84)
        XCTAssertEqual(OptionsAnalyticsPresentation.railWidth(for: 600), 112)
    }

    func testAccessibilitySummaryStatesFactsQualityAndAssumption() throws {
        let snapshot = try JSONDecoder().decode(
            OptionsAnalyticsSnapshotDTO.self,
            from: Data(OptionsAnalyticsContractTests.fixtureForPresentation.utf8)
        )
        var settings = OptionsAnalyticsSettings.default
        settings.enabled = true
        settings.showDealerProxy = true
        settings.showMarkedOi = true
        settings.showLiquidity = true

        let summary = OptionsAnalyticsPresentation.accessibilitySummary(
            snapshot: snapshot,
            settings: settings,
            now: DateParsing.dateTime("2026-07-19T14:31:05Z")!
        )

        XCTAssertTrue(summary.contains("Options Structure SPY expiration 2026-07-19"))
        XCTAssertTrue(summary.contains("Call gamma"))
        XCTAssertTrue(summary.contains("Put gamma"))
        XCTAssertTrue(summary.contains("per 1% underlying move"))
        XCTAssertTrue(summary.contains("partial"))
        XCTAssertTrue(summary.contains("Coverage 3 of 4 contracts, 75%"))
        XCTAssertTrue(summary.contains("quote age 61 seconds"))
        XCTAssertTrue(summary.contains("Assumption: calls long, puts short dealer proxy"))
        XCTAssertTrue(summary.contains("Warning: one crossed quote excluded"))
        XCTAssertTrue(summary.contains("Cache fresh"))
        XCTAssertTrue(summary.contains("OI effective 2026-07-18"))
        XCTAssertTrue(summary.contains("model-implied 68% range 576.20 to 591.80"))
        XCTAssertTrue(summary.contains("straddle breakevens 575.50 to 592.50"))
        XCTAssertTrue(summary.contains("Call wall 585.00"))
        XCTAssertTrue(summary.contains("Put wall 580.00"))
        XCTAssertTrue(summary.contains("Max OI strike 585.00"))
        XCTAssertTrue(summary.contains("Dealer gamma flip proxy roots 583.40, 587.20"))
        XCTAssertTrue(summary.contains("Spot 584.00, forward 584.20"))
        XCTAssertTrue(summary.contains("Settlement 2026-07-19T20:00:00Z"))
        XCTAssertTrue(summary.contains("Root SPY"))
        XCTAssertTrue(summary.contains("PM settlement"))
        XCTAssertTrue(summary.contains("Gross gamma concentration 42%"))
        XCTAssertTrue(summary.contains("Marked open interest layer"))
        XCTAssertTrue(summary.contains("Liquidity layer"))
    }

    func testAccessibilitySummaryLabelsUnavailableModeledStructure() throws {
        let observedOnly = OptionsAnalyticsContractTests.fixtureForPresentation
            .replacingOccurrences(of: "\"callGammaExposure\":120000", with: "\"callGammaExposure\":null")
            .replacingOccurrences(of: "\"putGammaExposure\":110000", with: "\"putGammaExposure\":null")
            .replacingOccurrences(of: "\"grossGammaExposure\":230000", with: "\"grossGammaExposure\":null")
            .replacingOccurrences(of: "\"callDeltaNotional\":36500000", with: "\"callDeltaNotional\":null")
            .replacingOccurrences(of: "\"putDeltaNotional\":-29100000", with: "\"putDeltaNotional\":null")
        let snapshot = try JSONDecoder().decode(
            OptionsAnalyticsSnapshotDTO.self,
            from: Data(observedOnly.utf8)
        )

        let summary = OptionsAnalyticsPresentation.accessibilitySummary(
            snapshot: snapshot,
            settings: .default
        )

        XCTAssertTrue(summary.contains("Call gamma unavailable"))
        XCTAssertTrue(summary.contains("Gross gamma unavailable"))
        XCTAssertFalse(summary.contains("Call gamma $0"))
    }

    private func makeLeg(
        gammaExposure: Double,
        markedOiValue: Double?,
        impliedVolatility: Double = 0.2,
        delta: Double = 0.5,
        gamma: Double = 0.01,
        deltaNotional: Double = 100,
        relativeSpread: Double? = nil,
        roundTripCost: Double? = nil,
        openInterest: Int = 1,
        volume: Int = 1,
        bidSize: Int = 1,
        askSize: Int = 1
    ) -> OptionsAnalyticsLegDTO {
        OptionsAnalyticsLegDTO(
            openInterest: openInterest,
            volume: volume,
            impliedVolatility: impliedVolatility,
            delta: delta,
            gamma: gamma,
            gammaExposure: gammaExposure,
            deltaNotional: deltaNotional,
            markedOiValue: markedOiValue,
            relativeSpread: relativeSpread,
            roundTripCost: roundTripCost,
            bidSize: bidSize,
            askSize: askSize,
            multiplier: 100
        )
    }

    private func makeStrike(
        strike: Double,
        call: OptionsAnalyticsLegDTO?,
        put: OptionsAnalyticsLegDTO?
    ) -> OptionsAnalyticsStrikeDTO {
        OptionsAnalyticsStrikeDTO(
            strike: strike,
            call: call,
            put: put,
            grossGammaExposure: (call?.gammaExposure ?? 0) + (put?.gammaExposure ?? 0),
            totalOpenInterest: (call?.openInterest ?? 0) + (put?.openInterest ?? 0)
        )
    }
}

private extension OptionsAnalyticsContractTests {
    static let fixtureForPresentation = """
    {"scope":{"symbol":"SPY","rootSymbol":"SPY","expiration":"2026-07-19","settlementStyle":"pm","observedAt":"2026-07-19T14:30:05Z","settlementAt":"2026-07-19T20:00:00Z","spot":584,"forward":584.2},"exposureUnit":"$ delta change per 1% underlying move","quality":{"quoteAsOf":"2026-07-19T14:30:04Z","greeksAsOf":"2026-07-19T14:30:00Z","oiEffectiveDate":"2026-07-18","feedMode":"realtime","coverage":{"contractsTotal":4,"contractsIncluded":3,"ratio":0.75},"status":"partial","warnings":["one crossed quote excluded"],"calculationVersion":"options-analytics-v1","cacheStatus":"fresh"},"structure":{"callGammaExposure":120000,"putGammaExposure":110000,"grossGammaExposure":230000,"callDeltaNotional":36500000,"putDeltaNotional":-29100000,"callWall":585,"putWall":580,"grossGammaConcentration":0.42,"maxOpenInterestStrike":585},"scenarios":{"callPutDealerProxy":{"assumption":"calls long, puts short dealer proxy","gammaExposure":15000,"deltaNotional":6200000,"strikeGammaExposures":[],"gammaRoots":[583.4,587.2],"primaryGammaRoot":583.4}},"impliedRange":{"lower":576.2,"upper":591.8,"confidence":0.68,"label":"model-implied 68% range","atmIv":0.192,"straddleLower":575.5,"straddleUpper":592.5},"strikes":[]}
    """
}
