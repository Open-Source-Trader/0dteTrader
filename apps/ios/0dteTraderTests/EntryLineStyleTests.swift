import UIKit
import XCTest
@testable import ZeroDTETrader

final class EntryLineStyleTests: XCTestCase {
    private func contract(strike: Double, type: OptionType, expiration: String) -> OptionContract {
        OptionContract(
            symbol: "SPY-\(Int(strike))-\(type.rawValue)",
            underlying: "SPY",
            expiration: expiration,
            strike: strike,
            optionType: type,
            bid: 1.0,
            ask: 1.04,
            last: 1.02
        )
    }

    // MARK: - Label

    func testLabel_zeroDteExpiration_says0DTE() {
        let today = DateParsing.day("2026-08-08") ?? Date(timeIntervalSince1970: 0)
        let label = EntryLineStyle.label(
            for: contract(strike: 500, type: .call, expiration: "2026-08-08"),
            today: today
        )
        XCTAssertEqual(label, "500C 0DTE")
    }

    func testLabel_futureExpiration_printsMonthDay() {
        let today = DateParsing.day("2026-08-04") ?? Date(timeIntervalSince1970: 0)
        let label = EntryLineStyle.label(
            for: contract(strike: 500, type: .put, expiration: "2026-08-08"),
            today: today
        )
        XCTAssertEqual(label, "500P Aug 8")
    }

    func testLabel_fractionalStrike_keepsTwoDecimals() {
        let today = DateParsing.day("2026-08-04") ?? Date(timeIntervalSince1970: 0)
        let label = EntryLineStyle.label(
            for: contract(strike: 502.5, type: .call, expiration: "2026-08-08"),
            today: today
        )
        XCTAssertEqual(label, "502.50C Aug 8")
    }

    func testLabel_unparseableExpiration_printsItVerbatim() {
        let today = DateParsing.day("2026-08-04") ?? Date(timeIntervalSince1970: 0)
        let label = EntryLineStyle.label(
            for: contract(strike: 500, type: .call, expiration: "not-a-date"),
            today: today
        )
        XCTAssertEqual(label, "500C not-a-date")
    }

    // MARK: - Stroke colour (one decision function: calls blue, puts red)

    func testStrokeColor_callUsesAccent() {
        XCTAssertEqual(EntryLineStyle.strokeColor(for: .call), UIColor.appAccent)
    }

    func testStrokeColor_putUsesNegative() {
        XCTAssertEqual(EntryLineStyle.strokeColor(for: .put), UIColor.appPnlNegative)
    }
}
