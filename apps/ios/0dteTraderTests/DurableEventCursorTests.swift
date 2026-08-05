import XCTest
@testable import ZeroDTETrader

final class DurableEventCursorTests: XCTestCase {
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: "DurableEventCursorTests")!
        defaults.removePersistentDomain(forName: "DurableEventCursorTests")
    }

    private func token(subject: String) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: ["sub": subject])
        let payload = data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return "header.\(payload).signature"
    }

    func testCursorPersistsPerUserAndRefusesGaps() throws {
        let first = DurableEventCursor(defaults: defaults, serverKey: "wss://example.test")
        first.activate(token: try token(subject: "user-a"))
        XCTAssertEqual(first.begin(eventID: "event-7", sequence: 7), .accepted)
        XCTAssertTrue(first.commit(eventID: "event-7", sequence: 7))

        let restarted = DurableEventCursor(defaults: defaults, serverKey: "wss://example.test")
        restarted.activate(token: try token(subject: "user-a"))
        XCTAssertEqual(restarted.sequence, 7)
        XCTAssertEqual(restarted.begin(eventID: "event-9", sequence: 9), .gap)
        XCTAssertEqual(restarted.sequence, 7)

        restarted.activate(token: try token(subject: "user-b"))
        XCTAssertEqual(restarted.sequence, 0)
    }

    func testEventIDWindowIsBounded() throws {
        let cursor = DurableEventCursor(defaults: defaults, serverKey: "wss://example.test")
        cursor.activate(token: try token(subject: "user-a"))
        for sequence in 1...700 {
            XCTAssertEqual(
                cursor.begin(eventID: "event-\(sequence)", sequence: sequence),
                .accepted
            )
            XCTAssertTrue(cursor.commit(eventID: "event-\(sequence)", sequence: sequence))
        }
        XCTAssertEqual(cursor.retainedEventCount, 512)
    }

    func testZeroBaselinePersistsAsResumable() throws {
        let first = DurableEventCursor(defaults: defaults, serverKey: "wss://example.test")
        first.activate(token: try token(subject: "user-a"))
        XCTAssertFalse(first.isResumable)
        first.establish(sequence: 0)

        let restarted = DurableEventCursor(defaults: defaults, serverKey: "wss://example.test")
        restarted.activate(token: try token(subject: "user-a"))
        XCTAssertTrue(restarted.isResumable)
        XCTAssertEqual(restarted.sequence, 0)
        XCTAssertEqual(restarted.begin(eventID: "event-2", sequence: 2), .gap)
        XCTAssertEqual(restarted.begin(eventID: "event-1", sequence: 1), .accepted)
    }

    func testCursorDoesNotPersistBeforeConsumerCommit() throws {
        let first = DurableEventCursor(defaults: defaults, serverKey: "wss://example.test")
        first.activate(token: try token(subject: "user-a"))
        XCTAssertEqual(first.begin(eventID: "event-1", sequence: 1), .accepted)
        XCTAssertEqual(first.sequence, 0)

        let beforeDelivery = DurableEventCursor(defaults: defaults, serverKey: "wss://example.test")
        beforeDelivery.activate(token: try token(subject: "user-a"))
        XCTAssertFalse(beforeDelivery.isResumable)

        XCTAssertTrue(first.commit(eventID: "event-1", sequence: 1))
        let afterDelivery = DurableEventCursor(defaults: defaults, serverKey: "wss://example.test")
        afterDelivery.activate(token: try token(subject: "user-a"))
        XCTAssertEqual(afterDelivery.sequence, 1)
    }

    func testPreEventBaselineReplaysAnEventQueuedBeforeItsConsumerExists() throws {
        let first = DurableEventCursor(defaults: defaults, serverKey: "wss://example.test")
        first.activate(token: try token(subject: "user-a"))
        first.establish(sequence: 6)

        let reconnected = DurableEventCursor(defaults: defaults, serverKey: "wss://example.test")
        reconnected.activate(token: try token(subject: "user-a"))
        XCTAssertEqual(reconnected.sequence, 6)
        XCTAssertEqual(reconnected.begin(eventID: "event-7", sequence: 7), .accepted)
    }
}
