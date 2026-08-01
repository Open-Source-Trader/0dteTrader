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

    /// Real-model smoke test (testing-and-observability.md: "Real native
    /// smoke: Supported macOS Foundation Models path"). Skips cleanly when
    /// Foundation Models isn't available — CI and non-macOS-26 machines
    /// exercise the deterministic tests above instead.
    func testLiveGenerationProducesAWireIdentityCompleteResult() async throws {
        guard case .ready = AvailabilityService.current() else {
            throw XCTSkip("Foundation Models unavailable on this machine")
        }

        let snapshot = AnalysisSnapshotInput(
            snapshotSchemaVersion: 1,
            identity: .init(
                snapshotId: "s1",
                capturedAt: "2026-07-31T00:00:00Z",
                symbol: "SPY",
                timeframe: "5m",
                candleCloseTime: nil,
                snapshotSequence: 7,
                positionVersion: 2,
                strategyPolicyVersion: nil
            ),
            trigger: .init(kind: "manual", priority: "manual", reason: "smoke test"),
            market: .object(["last": .number(580.25)]),
            candles: .array([.object(["o": .number(579), "h": .number(580), "l": .number(578.5), "c": .number(579.8), "v": .number(120000)])]),
            indicators: .object(["rsi": .number(58.2)]),
            levels: [
                CandidateLevelInput(
                    id: "lvl-1",
                    kind: "pivot",
                    role: "support",
                    price: 578.5,
                    evidence: "tested twice today",
                    testCount: 2,
                    recency: "today",
                    strength: 0.7,
                    source: "pivot-low"
                ),
            ],
            options: nil,
            position: nil,
            strategyPolicy: nil,
            quality: .object(["stale": .bool(false)]),
            omissions: []
        )

        let resultPayload = try await AnalysisRunner.run(snapshot: snapshot, analysisId: "smoke-1") { false }

        guard case let .object(fields) = resultPayload else {
            return XCTFail("expected an object payload")
        }
        XCTAssertEqual(fields["resultSchemaVersion"], .number(1))
        XCTAssertEqual(fields["analysisId"], .string("smoke-1"))
        guard case let .object(context)? = fields["context"] else {
            return XCTFail("expected a context object")
        }
        XCTAssertEqual(context["symbol"], .string("SPY"))
        XCTAssertEqual(context["snapshotSequence"], .number(7))
        XCTAssertNotNil(fields["generatedAt"])
        XCTAssertNotNil(fields["summary"])
    }
}
