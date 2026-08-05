import XCTest
@testable import ZeroDTETrader

final class DurableEventCursorTests: XCTestCase {
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: "DurableEventCursorTests")!
        defaults.removePersistentDomain(forName: "DurableEventCursorTests")
    }

    private func token(subject: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: ["sub": subject])
        let payload = data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return "header.\(payload).signature"
    }

    func testCursorPersistsPerUserAndRefusesGaps() {
        let first = DurableEventCursor(defaults: defaults, serverKey: "wss://example.test")
        first.activate(token: token(subject: "user-a"))
        XCTAssertEqual(first.accept(eventID: "event-7", sequence: 7), .accepted)

        let restarted = DurableEventCursor(defaults: defaults, serverKey: "wss://example.test")
        restarted.activate(token: token(subject: "user-a"))
        XCTAssertEqual(restarted.sequence, 7)
        XCTAssertEqual(restarted.accept(eventID: "event-9", sequence: 9), .gap)
        XCTAssertEqual(restarted.sequence, 7)

        restarted.activate(token: token(subject: "user-b"))
        XCTAssertEqual(restarted.sequence, 0)
    }

    func testEventIDWindowIsBounded() {
        let cursor = DurableEventCursor(defaults: defaults, serverKey: "wss://example.test")
        cursor.activate(token: token(subject: "user-a"))
        for sequence in 1...700 {
            XCTAssertEqual(
                cursor.accept(eventID: "event-\(sequence)", sequence: sequence),
                .accepted
            )
        }
        XCTAssertEqual(cursor.retainedEventCount, 512)
    }

    func testZeroBaselinePersistsAsResumable() {
        let first = DurableEventCursor(defaults: defaults, serverKey: "wss://example.test")
        first.activate(token: token(subject: "user-a"))
        XCTAssertFalse(first.isResumable)
        first.establish(sequence: 0)

        let restarted = DurableEventCursor(defaults: defaults, serverKey: "wss://example.test")
        restarted.activate(token: token(subject: "user-a"))
        XCTAssertTrue(restarted.isResumable)
        XCTAssertEqual(restarted.sequence, 0)
        XCTAssertEqual(restarted.accept(eventID: "event-2", sequence: 2), .gap)
        XCTAssertEqual(restarted.accept(eventID: "event-1", sequence: 1), .accepted)
    }
}
