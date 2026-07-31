import XCTest
@testable import ShimCore

final class AnalysisRunnerTests: XCTestCase {
    func testDecodesAWellFormedSnapshotPayload() {
        let payload = JSONValue.object([
            "snapshotSchemaVersion": .number(1),
            "identity": .object([
                "snapshotId": .string("s1"),
                "capturedAt": .string("2026-07-31T00:00:00Z"),
                "symbol": .string("SPY"),
                "timeframe": .string("5m"),
                "snapshotSequence": .number(1),
                "positionVersion": .number(0),
            ]),
            "trigger": .object([
                "kind": .string("manual"),
                "priority": .string("manual"),
                "reason": .string("user requested"),
            ]),
            "market": .object([:]),
            "candles": .object([:]),
            "indicators": .object([:]),
            "levels": .array([]),
            "quality": .object([:]),
            "omissions": .array([]),
        ])

        let snapshot = AnalysisRunner.decodeSnapshot(from: payload)
        XCTAssertNotNil(snapshot)
        XCTAssertEqual(snapshot?.identity.symbol, "SPY")
    }

    func testRejectsAMissingPayload() {
        XCTAssertNil(AnalysisRunner.decodeSnapshot(from: nil))
    }

    func testRejectsAPayloadMissingRequiredFields() {
        let payload = JSONValue.object(["identity": .object([:])])
        XCTAssertNil(AnalysisRunner.decodeSnapshot(from: payload))
    }

    func testRejectsAPayloadWithWrongFieldTypes() {
        let payload = JSONValue.object([
            "snapshotSchemaVersion": .string("not-a-number"),
            "identity": .object([:]),
            "trigger": .object([:]),
            "market": .object([:]),
            "candles": .object([:]),
            "indicators": .object([:]),
            "levels": .array([]),
            "quality": .object([:]),
            "omissions": .array([]),
        ])
        XCTAssertNil(AnalysisRunner.decodeSnapshot(from: payload))
    }
}
