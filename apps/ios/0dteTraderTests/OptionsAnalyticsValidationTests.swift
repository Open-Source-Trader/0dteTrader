// swiftlint:disable line_length
import XCTest
@testable import ZeroDTETrader

final class OptionsAnalyticsValidationTests: XCTestCase {
    private let decoder = JSONDecoder()

    func testSupportedFiniteExactKeySnapshotValidates() throws {
        let snapshot = try decode(Self.validJSON)
        XCTAssertNoThrow(
            try snapshot.validated(expectedSymbol: "SPY", expectedExpiration: "2026-07-19")
        )
        let proxyExposure: Double = try XCTUnwrap(
            snapshot.scenarios.callPutDealerProxy?.strikeGammaExposures[0].gammaExposure
        )
        XCTAssertEqual(proxyExposure, 50)
    }

    func testAcceptsObservedOnlySnapshotWithNullModeledStructure() {
        let observedOnly = Self.validJSON
            .replacingOccurrences(of: "\"greeksAsOf\":\"2026-07-19T14:30:00Z\"", with: "\"greeksAsOf\":null")
            .replacingOccurrences(
                of: "\"contractsTotal\":2,\"contractsIncluded\":2,\"ratio\":1",
                with: "\"contractsTotal\":2,\"contractsIncluded\":0,\"ratio\":0"
            )
            .replacingOccurrences(of: "\"status\":\"complete\"", with: "\"status\":\"partial\"")
            .replacingOccurrences(of: "\"callGammaExposure\":100", with: "\"callGammaExposure\":null")
            .replacingOccurrences(of: "\"putGammaExposure\":80", with: "\"putGammaExposure\":null")
            .replacingOccurrences(of: "\"grossGammaExposure\":180", with: "\"grossGammaExposure\":null")
            .replacingOccurrences(of: "\"callDeltaNotional\":1000", with: "\"callDeltaNotional\":null")
            .replacingOccurrences(of: "\"putDeltaNotional\":-800", with: "\"putDeltaNotional\":null")

        XCTAssertNoThrow(try decode(observedOnly))
    }

    func testRejectsUnsupportedLiteralContracts() {
        assertDecodeFails(replacing: "\"realtime\"", with: "\"streaming\"")
        assertDecodeFails(replacing: "\"complete\"", with: "\"ok\"")
        assertDecodeFails(replacing: "\"fresh\"", with: "\"forever\"")
        assertDecodeFails(replacing: "\"settlementStyle\":\"pm\"", with: "\"settlementStyle\":\"weekly\"")
        assertDecodeFails(
            replacing: "\"$ delta change per 1% underlying move\"",
            with: "\"gamma dollars\""
        )
        assertDecodeFails(replacing: "\"model-implied 68% range\"", with: "\"expected move\"")
        assertDecodeFails(replacing: "\"confidence\":0.68", with: "\"confidence\":0.95")
    }

    func testRejectsInvalidCoverageNonFiniteAndUnsortedStrikes() {
        assertDecodeFails(replacing: "\"ratio\":1", with: "\"ratio\":1.1")
        assertDecodeFails(replacing: "\"spot\":584", with: "\"spot\":1e999")
        assertDecodeFails(
            replacing: "\"strike\":580,\"call\"",
            with: "\"strike\":590,\"call\""
        )
    }

    func testAcceptsZeroLowerBoundsForClampedRanges() {
        let zeroBoundaries = Self.validJSON
            .replacingOccurrences(of: "\"lower\":575", with: "\"lower\":0")
            .replacingOccurrences(of: "\"straddleLower\":574", with: "\"straddleLower\":0")

        XCTAssertNoThrow(try decode(zeroBoundaries))
    }

    func testRangeBoundsAllowEqualityButRejectReversedOrdering() {
        let coincidentBounds = Self.validJSON
            .replacingOccurrences(of: "\"lower\":575", with: "\"lower\":593")
            .replacingOccurrences(of: "\"straddleLower\":574", with: "\"straddleLower\":594")
        XCTAssertNoThrow(try decode(coincidentBounds))

        assertDecodeFails(replacing: "\"lower\":575", with: "\"lower\":594")
        assertDecodeFails(replacing: "\"straddleLower\":574", with: "\"straddleLower\":595")
    }

    func testRejectsResponseForDifferentSymbolOrExactExpiration() throws {
        let snapshot = try decode(Self.validJSON)
        XCTAssertThrowsError(
            try snapshot.validated(expectedSymbol: "QQQ", expectedExpiration: "2026-07-19")
        )
        XCTAssertThrowsError(
            try snapshot.validated(expectedSymbol: "SPY", expectedExpiration: "2026-07-20")
        )
    }

    func testRejectsMissingProductAndSettlementProvenance() {
        assertDecodeFails(replacing: "\"rootSymbol\":\"SPY\",", with: "")
        assertDecodeFails(replacing: "\"settlementStyle\":\"pm\",", with: "")
    }

    func testRejectsRootThatDoesNotMatchRequestedProduct() {
        assertDecodeFails(replacing: "\"rootSymbol\":\"SPY\"", with: "\"rootSymbol\":\"QQQ\"")

        let unrelatedSPXRoot = Self.validJSON
            .replacingOccurrences(of: "\"symbol\":\"SPY\"", with: "\"symbol\":\"SPX\"")
            .replacingOccurrences(of: "\"rootSymbol\":\"SPY\"", with: "\"rootSymbol\":\"QQQ\"")
        XCTAssertThrowsError(try decode(unrelatedSPXRoot))
    }

    func testRejectsSettlementStyleThatDoesNotMatchProductRoot() {
        assertDecodeFails(replacing: "\"settlementStyle\":\"pm\"", with: "\"settlementStyle\":\"am\"")

        let pmSettledSPXRoot = Self.validJSON
            .replacingOccurrences(of: "\"symbol\":\"SPY\"", with: "\"symbol\":\"SPX\"")
            .replacingOccurrences(of: "\"rootSymbol\":\"SPY\"", with: "\"rootSymbol\":\"SPX\"")
        XCTAssertThrowsError(try decode(pmSettledSPXRoot))

        let amSettledSPXWRoot = Self.validJSON
            .replacingOccurrences(of: "\"symbol\":\"SPY\"", with: "\"symbol\":\"SPX\"")
            .replacingOccurrences(of: "\"rootSymbol\":\"SPY\"", with: "\"rootSymbol\":\"SPXW\"")
            .replacingOccurrences(of: "\"settlementStyle\":\"pm\"", with: "\"settlementStyle\":\"am\"")
        XCTAssertThrowsError(try decode(amSettledSPXWRoot))
    }

    func testAcceptsSupportedSPXProductRootsAndSettlementStyles() {
        let amSettledSPXRoot = Self.validJSON
            .replacingOccurrences(of: "\"symbol\":\"SPY\"", with: "\"symbol\":\"SPX\"")
            .replacingOccurrences(of: "\"rootSymbol\":\"SPY\"", with: "\"rootSymbol\":\"SPX\"")
            .replacingOccurrences(of: "\"settlementStyle\":\"pm\"", with: "\"settlementStyle\":\"am\"")
        XCTAssertNoThrow(try decode(amSettledSPXRoot))

        let pmSettledSPXWRoot = Self.validJSON
            .replacingOccurrences(of: "\"symbol\":\"SPY\"", with: "\"symbol\":\"SPX\"")
            .replacingOccurrences(of: "\"rootSymbol\":\"SPY\"", with: "\"rootSymbol\":\"SPXW\"")
        XCTAssertNoThrow(try decode(pmSettledSPXWRoot))
    }

    private func decode(_ json: String) throws -> OptionsAnalyticsSnapshotDTO {
        try decoder.decode(OptionsAnalyticsSnapshotDTO.self, from: Data(json.utf8))
    }

    private func assertDecodeFails(
        replacing target: String,
        with replacement: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertThrowsError(
            try decode(Self.validJSON.replacingOccurrences(of: target, with: replacement)),
            file: file,
            line: line
        )
    }

    private static let validJSON = """
    {"scope":{"symbol":"SPY","rootSymbol":"SPY","expiration":"2026-07-19","settlementStyle":"pm","observedAt":"2026-07-19T14:30:05Z","settlementAt":"2026-07-19T20:00:00Z","spot":584,"forward":584.2},"exposureUnit":"$ delta change per 1% underlying move","quality":{"quoteAsOf":"2026-07-19T14:30:04Z","greeksAsOf":"2026-07-19T14:30:00Z","oiEffectiveDate":"2026-07-18","feedMode":"realtime","coverage":{"contractsTotal":2,"contractsIncluded":2,"ratio":1},"status":"complete","warnings":[],"calculationVersion":"options-analytics-v1","cacheStatus":"fresh"},"structure":{"callGammaExposure":100,"putGammaExposure":80,"grossGammaExposure":180,"callDeltaNotional":1000,"putDeltaNotional":-800,"callWall":585,"putWall":580,"grossGammaConcentration":0.55,"maxOpenInterestStrike":585},"scenarios":{"callPutDealerProxy":{"assumption":"calls long, puts short dealer proxy","gammaExposure":20,"deltaNotional":200,"strikeGammaExposures":[{"strike":580,"gammaExposure":50},{"strike":585,"gammaExposure":-30}],"gammaRoots":[582,586],"primaryGammaRoot":582}},"impliedRange":{"lower":575,"upper":593,"confidence":0.68,"label":"model-implied 68% range","atmIv":0.2,"straddleLower":574,"straddleUpper":594},"strikes":[{"strike":580,"call":null,"put":null,"grossGammaExposure":80,"totalOpenInterest":100},{"strike":585,"call":null,"put":null,"grossGammaExposure":100,"totalOpenInterest":120}]}
    """
}
