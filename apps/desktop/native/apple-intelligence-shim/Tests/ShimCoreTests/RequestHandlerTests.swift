import XCTest
@testable import ShimCore

/// `RequestHandler.handle`'s `emit` closure is `@Sendable`, so tests collect
/// emitted events through a lock-protected box (synchronous, unlike an actor
/// hop, so events are visible immediately after `handle` returns — Phase 1's
/// synchronous paths like hello/prewarm/shutdown emit before `handle`
/// returns, and a fire-and-forget `Task` would race the assertion).
final class EventBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [NativeEvent] = []

    func append(_ event: NativeEvent) {
        lock.lock()
        defer { lock.unlock() }
        storage.append(event)
    }

    var events: [NativeEvent] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}

final class RequestHandlerTests: XCTestCase {
    func testHelloProducesReadyEventWithinRequest() async {
        let handler = RequestHandler()
        let request = NativeRequest(
            protocolVersion: protocolVersion,
            requestId: "runtime",
            method: .runtimeHello,
            deadlineAt: nil,
            payload: nil
        )

        let box = EventBox()
        await handler.handle(request) { box.append($0) }

        XCTAssertEqual(box.events.count, 1)
        XCTAssertEqual(box.events.first?.event, .ready)
        XCTAssertEqual(box.events.first?.requestId, "runtime")
    }

    func testCancelWithNoActiveRequestEmitsNoEvent() async {
        let handler = RequestHandler()
        let request = NativeRequest(
            protocolVersion: protocolVersion,
            requestId: "does-not-exist",
            method: .analysisCancel,
            deadlineAt: nil,
            payload: nil
        )

        let box = EventBox()
        await handler.handle(request) { box.append($0) }

        XCTAssertTrue(box.events.isEmpty)
    }

    func testPrewarmCompletesImmediately() async {
        let handler = RequestHandler()
        let request = NativeRequest(
            protocolVersion: protocolVersion,
            requestId: "r1",
            method: .runtimePrewarm,
            deadlineAt: nil,
            payload: nil
        )

        let box = EventBox()
        await handler.handle(request) { box.append($0) }

        XCTAssertEqual(box.events.map(\.event), [.completed])
    }

    func testShutdownEmitsCompleted() async {
        let handler = RequestHandler()
        let request = NativeRequest(
            protocolVersion: protocolVersion,
            requestId: "r1",
            method: .runtimeShutdown,
            deadlineAt: nil,
            payload: nil
        )

        let box = EventBox()
        await handler.handle(request) { box.append($0) }

        XCTAssertTrue(box.events.contains { $0.event == .completed })
    }
}
