import XCTest
@testable import ShimCore

final class ShimTelemetryTests: XCTestCase {
    func testDescribeIncludesOnlyProvidedFields() {
        let event = ShimTelemetryEvent(
            name: "analysis_context",
            requestId: "req-1",
            analysisDurationMs: 42,
            snapshotBytes: 1200,
            promptChars: 900,
            omissionCodes: ["options-trimmed", "levels-trimmed"]
        )

        let line = event.describe()
        XCTAssertTrue(line.contains("event=analysis_context"))
        XCTAssertTrue(line.contains("requestId=req-1"))
        XCTAssertTrue(line.contains("analysisDurationMs=42"))
        XCTAssertTrue(line.contains("snapshotBytes=1200"))
        XCTAssertTrue(line.contains("promptChars=900"))
        XCTAssertTrue(line.contains("omissionCodes=options-trimmed,levels-trimmed"))
    }

    func testDescribeOmitsAbsentFields() {
        let event = ShimTelemetryEvent(name: "analysis_context", requestId: "req-2")
        let line = event.describe()

        XCTAssertEqual(line, "event=analysis_context requestId=req-2")
        XCTAssertFalse(line.contains("analysisDurationMs"))
        XCTAssertFalse(line.contains("snapshotBytes"))
        XCTAssertFalse(line.contains("promptChars"))
        XCTAssertFalse(line.contains("omissionCodes"))
    }

    func testNoopSinkAcceptsEventsWithoutSideEffects() {
        // Exercises the default parameter path used by every AnalysisRunner
        // call site that doesn't pass a telemetry sink explicitly.
        noopTelemetrySink(ShimTelemetryEvent(name: "analysis_context"))
    }
}
