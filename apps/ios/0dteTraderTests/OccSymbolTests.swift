import XCTest
@testable import ZeroDTETrader

final class OccSymbolTests: XCTestCase {
    func testParsesAStandardSymbol() {
        let parsed = OccSymbol.parse("SPY260717C00503000")
        XCTAssertEqual(parsed?.underlying, "SPY")
        XCTAssertEqual(parsed?.expiration, "2026-07-17")
        XCTAssertEqual(parsed?.optionType, .call)
        XCTAssertEqual(parsed?.strike, 503)
    }

    func testParsesFractionalStrikesAndPuts() {
        let parsed = OccSymbol.parse("QQQ261218P00482500")
        XCTAssertEqual(parsed?.optionType, .put)
        XCTAssertEqual(parsed?.expiration, "2026-12-18")
        XCTAssertEqual(parsed?.strike, 482.5)
    }

    func testRejectsNonOccSymbols() {
        XCTAssertNil(OccSymbol.parse("MESU26"))
        XCTAssertNil(OccSymbol.parse("SPY"))
        XCTAssertNil(OccSymbol.parse("spy260717C00503000"))
        XCTAssertNil(OccSymbol.parse("SPY260717X00503000"))
        XCTAssertNil(OccSymbol.parse(""))
    }
}
