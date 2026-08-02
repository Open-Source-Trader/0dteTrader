import XCTest
@testable import ZeroDTETrader

/// History's display-only status mapping: pending states read as "Waiting";
/// `OrderStatus.displayName` itself stays untouched for toasts and chips.
final class HistoryStatusStyleTests: XCTestCase {
    func testSubmittedReadsAsWaiting() {
        XCTAssertEqual(HistoryStatusStyle.label(for: .submitted), "Waiting")
    }

    func testPartiallyFilledReadsAsWaitingPartialFill() {
        XCTAssertEqual(HistoryStatusStyle.label(for: .partiallyFilled), "Waiting · partial fill")
    }

    func testTerminalStatusesKeepDisplayName() {
        XCTAssertEqual(HistoryStatusStyle.label(for: .filled), "Filled")
        XCTAssertEqual(HistoryStatusStyle.label(for: .cancelled), "Cancelled")
        XCTAssertEqual(HistoryStatusStyle.label(for: .rejected), "Rejected")
        XCTAssertEqual(HistoryStatusStyle.label(for: .unknown), "Unknown")
    }

    func testOnlyPendingStatesArePending() {
        XCTAssertTrue(HistoryStatusStyle.isPending(.submitted))
        XCTAssertTrue(HistoryStatusStyle.isPending(.partiallyFilled))
        XCTAssertFalse(HistoryStatusStyle.isPending(.filled))
        XCTAssertFalse(HistoryStatusStyle.isPending(.cancelled))
        XCTAssertFalse(HistoryStatusStyle.isPending(.rejected))
        XCTAssertFalse(HistoryStatusStyle.isPending(.unknown))
    }

    /// The wire wording must survive: history's relabel is display-only.
    func testOrderStatusDisplayNameUntouched() {
        XCTAssertEqual(OrderStatus.submitted.displayName, "Submitted")
        XCTAssertEqual(OrderStatus.partiallyFilled.displayName, "Partially filled")
    }
}
