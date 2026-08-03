import XCTest
@testable import ShimCore

final class ContextBudgeterTests: XCTestCase {
    private func makeSnapshot(
        levelCount: Int = 3,
        includeOptions: Bool = true,
        includeStrategyPolicy: Bool = true,
        includePosition: Bool = true,
        triggerKind: String = "manual"
    ) -> AnalysisSnapshotInput {
        let levels = (0..<levelCount).map { index in
            CandidateLevelInput(
                id: "lvl-\(index)",
                kind: "support",
                role: "support",
                price: 400 + Double(index),
                evidence: "tested",
                testCount: 3,
                recency: "today",
                strength: Double(levelCount - index),
                source: "pivot"
            )
        }
        return AnalysisSnapshotInput(
            snapshotSchemaVersion: 1,
            identity: .init(
                snapshotId: "s1",
                capturedAt: "2026-07-31T00:00:00Z",
                symbol: "SPY",
                timeframe: "5m",
                candleCloseTime: nil,
                snapshotSequence: 1,
                positionVersion: 0,
                strategyPolicyVersion: nil
            ),
            trigger: .init(kind: triggerKind, priority: "manual", reason: "user requested"),
            market: .object(["last": .number(400)]),
            candles: .object(["count": .number(50)]),
            indicators: .object(["rsi": .number(55)]),
            levels: levels,
            options: includeOptions ? .object(["callWall": .number(410)]) : nil,
            position: includePosition ? .object(["quantity": .number(1)]) : nil,
            strategyPolicy: includeStrategyPolicy ? .object(["maxLoss": .number(100)]) : nil,
            quality: .object(["stale": .bool(false)]),
            omissions: []
        )
    }

    func testBudgetStaysUnderMaxCharactersForNormalSnapshot() {
        let budgeted = ContextBudgeter.build(from: makeSnapshot())
        XCTAssertLessThanOrEqual(budgeted.text.count, ContextBudgeter.maxPromptCharacters)
    }

    func testIncludesSymbolAndCandidateLevels() {
        let budgeted = ContextBudgeter.build(from: makeSnapshot())
        XCTAssertTrue(budgeted.text.contains("SPY"))
        XCTAssertTrue(budgeted.text.contains("lvl-0"))
    }

    /// Candles render via the shared CandleEncoding package's lossless
    /// base+delta table (adapter-wiring level — the encoder's own format
    /// correctness is covered by CandleEncodingTests) rather than raw JSON.
    func testCandlesRenderAsADeltaTableNotRawJSON() {
        var snapshot = makeSnapshot()
        let recent = JSONValue.array([
            .object([
                "time": .number(1_700_000_000), "open": .number(579.12), "high": .number(580.45),
                "low": .number(578.67), "close": .number(579.89), "volume": .number(123456),
            ]),
            .object([
                "time": .number(1_700_000_300), "open": .number(579.90), "high": .number(580.10),
                "low": .number(579.50), "close": .number(579.95), "volume": .number(98000),
            ]),
        ])
        snapshot = AnalysisSnapshotInput(
            snapshotSchemaVersion: snapshot.snapshotSchemaVersion,
            identity: snapshot.identity,
            trigger: snapshot.trigger,
            market: snapshot.market,
            candles: .object(["count": .number(2), "recent": recent]),
            indicators: snapshot.indicators,
            levels: snapshot.levels,
            options: snapshot.options,
            position: snapshot.position,
            strategyPolicy: snapshot.strategyPolicy,
            quality: snapshot.quality,
            omissions: snapshot.omissions
        )

        let budgeted = ContextBudgeter.build(from: snapshot)
        XCTAssertTrue(budgeted.text.contains("encoding=b1-absolute-bars2plus-delta-from-previous-close"))
        XCTAssertTrue(budgeted.text.contains("B1: 579.12,580.45,578.67,579.89,123456"))
        XCTAssertTrue(budgeted.text.contains("B2:"))
        XCTAssertFalse(budgeted.text.contains("\"open\""), "candles must not render as raw JSON anymore")
    }

    func testManagementTaskWithoutPositionIsDowngraded() {
        let snapshot = makeSnapshot(includePosition: false, triggerKind: "position-change")
        let budgeted = ContextBudgeter.build(from: snapshot)
        XCTAssertTrue(budgeted.downgradedToObservationOnly)
        XCTAssertTrue(budgeted.text.contains("observation-only"))
    }

    func testNonManagementTaskWithoutPositionIsNotDowngraded() {
        let snapshot = makeSnapshot(includePosition: false, triggerKind: "manual")
        let budgeted = ContextBudgeter.build(from: snapshot)
        XCTAssertFalse(budgeted.downgradedToObservationOnly)
    }

    /// Position presence/absence must reach the model on every trigger
    /// kind, not just position-change/material-change — a manual or
    /// candle-close analysis while flat still needs "POSITION: none" so the
    /// model knows to propose entries instead of guessing at hold/exit.
    func testNoPositionStatesNoneRegardlessOfTriggerKind() {
        let snapshot = makeSnapshot(includePosition: false, triggerKind: "manual")
        let budgeted = ContextBudgeter.build(from: snapshot)
        XCTAssertTrue(budgeted.text.contains("POSITION: none"))
    }

    func testHeldPositionStatesPositionDetailRegardlessOfTriggerKind() {
        let snapshot = makeSnapshot(includePosition: true, triggerKind: "manual")
        let budgeted = ContextBudgeter.build(from: snapshot)
        XCTAssertTrue(budgeted.text.contains("POSITION: {"))
        XCTAssertFalse(budgeted.text.contains("POSITION: none"))
    }

    func testOversizedSnapshotIsTrimmedUnderBudgetAndDeclaresOmissions() {
        // A large candle blob forces the budgeter to trim options first,
        // then levels, before strategy policy.
        var snapshot = makeSnapshot(levelCount: 40)
        let hugeCandles = JSONValue.object([
            "count": .number(400),
            "recent": .array((0..<400).map { index in
                .object([
                    "time": .number(Double(index)),
                    "open": .number(1), "high": .number(2), "low": .number(0.5),
                    "close": .number(1.5), "volume": .number(1000),
                ])
            }),
        ])
        snapshot = AnalysisSnapshotInput(
            snapshotSchemaVersion: snapshot.snapshotSchemaVersion,
            identity: snapshot.identity,
            trigger: snapshot.trigger,
            market: snapshot.market,
            candles: hugeCandles,
            indicators: snapshot.indicators,
            levels: snapshot.levels,
            options: snapshot.options,
            position: snapshot.position,
            strategyPolicy: snapshot.strategyPolicy,
            quality: snapshot.quality,
            omissions: snapshot.omissions
        )

        let budgeted = ContextBudgeter.build(from: snapshot)
        XCTAssertLessThanOrEqual(budgeted.text.count, ContextBudgeter.maxPromptCharacters)
        XCTAssertFalse(budgeted.omissions.isEmpty)
        XCTAssertFalse(budgeted.text.contains("callWall"), "options should have been trimmed first")
    }

    /// AnalysisSnapshotBuilder.ts's real wire shape for candles is
    /// `{ count, recent: Candle[] }` — an object wrapping the array, not a
    /// bare array. The trim lever must look inside `recent`; a snapshot
    /// with 50 real-sized candles under `recent` previously slipped past
    /// every lever (candleCount saw a non-array top level and returned
    /// nil), so budget was exceeded silently until the model rejected the
    /// oversized request with exceededContextWindowSize.
    func testOversizedRealShapedCandlesAreTrimmedViaTheRecentField() {
        // Even the compact delta-table encoding needs a genuinely large
        // candle count to force this lever — 2000 candles of real-sized,
        // varying values comfortably exceeds budget on its own once
        // options/indicators/levels are already exhausted.
        var snapshot = makeSnapshot(levelCount: 40)
        var recentItems: [JSONValue] = []
        for index in 0..<2000 {
            let openOffset: Double = Double(index % 7) * 0.31
            let highOffset: Double = Double(index % 5) * 0.22
            let lowOffset: Double = Double(index % 3) * 0.18
            let closeOffset: Double = Double(index % 11) * 0.09
            let volume: Double = Double(100000 + index * 137)
            recentItems.append(
                .object([
                    "time": .number(Double(index)),
                    "open": .number(579.12 + openOffset),
                    "high": .number(580.45 + highOffset),
                    "low": .number(578.67 - lowOffset),
                    "close": .number(579.89 + closeOffset),
                    "volume": .number(volume),
                ])
            )
        }
        let realShapedCandles = JSONValue.object(["count": .number(2000), "recent": .array(recentItems)])
        snapshot = AnalysisSnapshotInput(
            snapshotSchemaVersion: snapshot.snapshotSchemaVersion,
            identity: snapshot.identity,
            trigger: snapshot.trigger,
            market: snapshot.market,
            candles: realShapedCandles,
            indicators: snapshot.indicators,
            levels: snapshot.levels,
            options: snapshot.options,
            position: snapshot.position,
            strategyPolicy: snapshot.strategyPolicy,
            quality: snapshot.quality,
            omissions: snapshot.omissions
        )

        let budgeted = ContextBudgeter.build(from: snapshot)
        XCTAssertLessThanOrEqual(budgeted.text.count, ContextBudgeter.maxPromptCharacters)
        XCTAssertTrue(budgeted.omissions.contains { $0.code == "candles-trimmed" })
    }

    /// POSITION is never trimmed by a lever (priority 1, "never silently
    /// omitted") — if it alone is large enough to exceed budget after every
    /// other lever is exhausted, the hard-truncation backstop must still
    /// guarantee compliance rather than returning an oversized prompt.
    func testHardTruncationBackstopCapsAnUntrimmableOversizedPosition() {
        var snapshot = makeSnapshot(levelCount: 1, includeOptions: false, includeStrategyPolicy: false)
        let hugePosition = JSONValue.object(
            Dictionary(uniqueKeysWithValues: (0..<500).map { ("field\($0)", JSONValue.string(String(repeating: "x", count: 20))) })
        )
        snapshot = AnalysisSnapshotInput(
            snapshotSchemaVersion: snapshot.snapshotSchemaVersion,
            identity: snapshot.identity,
            trigger: snapshot.trigger,
            market: snapshot.market,
            candles: .object(["count": .number(0), "recent": .array([])]),
            indicators: snapshot.indicators,
            levels: snapshot.levels,
            options: nil,
            position: hugePosition,
            strategyPolicy: nil,
            quality: snapshot.quality,
            omissions: snapshot.omissions
        )

        let budgeted = ContextBudgeter.build(from: snapshot)
        XCTAssertLessThanOrEqual(budgeted.text.count, ContextBudgeter.maxPromptCharacters)
        XCTAssertTrue(budgeted.omissions.contains { $0.code == "prompt-truncated" })
    }

    func testDeterministic() {
        let snapshot = makeSnapshot()
        let first = ContextBudgeter.build(from: snapshot).text
        let second = ContextBudgeter.build(from: snapshot).text
        XCTAssertEqual(first, second)
    }
}
