// swiftlint:disable line_length
import XCTest
@testable import ZeroDTETrader

final class OptionsAnalyticsContractTests: XCTestCase {
    private let decoder = JSONDecoder()

    func testCanonicalSharedFixtureDecodesAndValidatesExactProduct() throws {
        let repositoryRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let fixtureURL = repositoryRoot
            .appendingPathComponent("packages/shared-types/fixtures/options-analytics-v1.json")
        let snapshot = try decoder.decode(
            OptionsAnalyticsSnapshotDTO.self,
            from: Data(contentsOf: fixtureURL)
        )

        let validated = try snapshot.validated(
            expectedSymbol: "SPX",
            expectedExpiration: "2026-07-20"
        )

        XCTAssertEqual(validated.scope.rootSymbol, "SPXW")
        XCTAssertEqual(validated.scope.settlementStyle, .pm)
        XCTAssertEqual(validated.strikes.count, 3)
        XCTAssertEqual(
            validated.scenarios.callPutDealerProxy?.strikeGammaExposures[1].gammaExposure,
            500_000
        )
        XCTAssertNil(validated.strikes.last?.call?.impliedVolatility)
        XCTAssertEqual(validated.strikes.last?.call?.markedOiValue, 1_000)
        XCTAssertNil(validated.strikes.last?.grossGammaExposure)
    }

    func testSnapshotDecodesCanonicalNestedContract() throws {
        let data = Data(fixture.utf8)
        let snapshot = try decoder.decode(OptionsAnalyticsSnapshotDTO.self, from: data)

        XCTAssertEqual(snapshot.scope.symbol, "SPY")
        XCTAssertEqual(snapshot.scope.rootSymbol, "SPY")
        XCTAssertEqual(snapshot.scope.expiration, "2026-07-19")
        XCTAssertEqual(snapshot.scope.settlementStyle, .pm)
        XCTAssertEqual(snapshot.scope.settlementAt, "2026-07-19T20:00:00Z")
        XCTAssertEqual(snapshot.exposureUnit, "$ delta change per 1% underlying move")
        XCTAssertEqual(snapshot.quality.feedMode, .realtime)
        XCTAssertEqual(snapshot.quality.coverage.contractsTotal, 4)
        XCTAssertEqual(snapshot.quality.coverage.contractsIncluded, 3)
        XCTAssertEqual(snapshot.quality.coverage.ratio, 0.75, accuracy: 1e-12)
        XCTAssertEqual(snapshot.quality.status, .partial)
        XCTAssertEqual(snapshot.quality.cacheStatus, .fresh)
        XCTAssertEqual(snapshot.structure.grossGammaExposure, 230_000)
        XCTAssertEqual(snapshot.structure.grossGammaConcentration, 0.42)
        XCTAssertEqual(snapshot.scenarios.callPutDealerProxy?.gammaRoots, [583.4, 587.2])
        XCTAssertEqual(snapshot.scenarios.callPutDealerProxy?.primaryGammaRoot, 583.4)
        XCTAssertEqual(snapshot.impliedRange?.confidence, 0.68)
        XCTAssertEqual(snapshot.impliedRange?.straddleUpper, 592.5)
        XCTAssertEqual(snapshot.strikes.count, 1)
        XCTAssertEqual(snapshot.strikes[0].call?.openInterest, 1_200)
        XCTAssertEqual(snapshot.strikes[0].put?.roundTripCost, 0.08)
        XCTAssertEqual(snapshot.strikes[0].totalOpenInterest, 2_100)
        XCTAssertEqual(
            snapshot.scenarios.callPutDealerProxy?.strikeGammaExposures[0].gammaExposure,
            15_000
        )
    }

    func testSnapshotDecodesNullableLayersWithoutInventingValues() throws {
        let json = fixture
            .replacingOccurrences(of: "\"greeksAsOf\":\"2026-07-19T14:30:00Z\"", with: "\"greeksAsOf\":null")
            .replacingOccurrences(of: scenarioJSON, with: "\"callPutDealerProxy\":null")
            .replacingOccurrences(of: impliedRangeJSON, with: "\"impliedRange\":null")
            .replacingOccurrences(of: "\"call\":{\"openInterest\":1200,\"volume\":210,\"impliedVolatility\":0.19,\"delta\":0.52,\"gamma\":0.031,\"gammaExposure\":120000,\"deltaNotional\":36500000,\"markedOiValue\":144000,\"relativeSpread\":0.04,\"roundTripCost\":0.08,\"bidSize\":31,\"askSize\":27,\"multiplier\":100}", with: "\"call\":null")

        let snapshot = try decoder.decode(OptionsAnalyticsSnapshotDTO.self, from: Data(json.utf8))

        XCTAssertNil(snapshot.quality.greeksAsOf)
        XCTAssertNil(snapshot.scenarios.callPutDealerProxy)
        XCTAssertNil(snapshot.impliedRange)
        XCTAssertNil(snapshot.strikes[0].call)
    }

    private var scenarioJSON: String {
        "\"callPutDealerProxy\":{\"assumption\":\"calls long, puts short dealer proxy\",\"gammaExposure\":15000,\"deltaNotional\":6200000,\"strikeGammaExposures\":[{\"strike\":585,\"gammaExposure\":15000}],\"gammaRoots\":[583.4,587.2],\"primaryGammaRoot\":583.4}"
    }

    private var impliedRangeJSON: String {
        "\"impliedRange\":{\"lower\":576.2,\"upper\":591.8,\"confidence\":0.68,\"label\":\"model-implied 68% range\",\"atmIv\":0.192,\"straddleLower\":575.5,\"straddleUpper\":592.5}"
    }

    private var fixture: String {
        """
        {
          "scope":{"symbol":"SPY","rootSymbol":"SPY","expiration":"2026-07-19","settlementStyle":"pm","observedAt":"2026-07-19T14:30:05Z","settlementAt":"2026-07-19T20:00:00Z","spot":584,"forward":584.2},
          "exposureUnit":"$ delta change per 1% underlying move",
          "quality":{"quoteAsOf":"2026-07-19T14:30:04Z","greeksAsOf":"2026-07-19T14:30:00Z","oiEffectiveDate":"2026-07-18","feedMode":"realtime","coverage":{"contractsTotal":4,"contractsIncluded":3,"ratio":0.75},"status":"partial","warnings":["one crossed quote excluded"],"calculationVersion":"options-analytics-v1","cacheStatus":"fresh"},
          "structure":{"callGammaExposure":120000,"putGammaExposure":110000,"grossGammaExposure":230000,"callDeltaNotional":36500000,"putDeltaNotional":-29100000,"callWall":585,"putWall":580,"grossGammaConcentration":0.42,"maxOpenInterestStrike":585},
          "scenarios":{\(scenarioJSON)},
          \(impliedRangeJSON),
          "strikes":[{"strike":585,"call":{"openInterest":1200,"volume":210,"impliedVolatility":0.19,"delta":0.52,"gamma":0.031,"gammaExposure":120000,"deltaNotional":36500000,"markedOiValue":144000,"relativeSpread":0.04,"roundTripCost":0.08,"bidSize":31,"askSize":27,"multiplier":100},"put":{"openInterest":900,"volume":180,"impliedVolatility":0.2,"delta":-0.48,"gamma":0.03,"gammaExposure":110000,"deltaNotional":-29100000,"markedOiValue":126000,"relativeSpread":0.05,"roundTripCost":0.08,"bidSize":29,"askSize":25,"multiplier":100},"grossGammaExposure":230000,"totalOpenInterest":2100}]
        }
        """
    }
}
