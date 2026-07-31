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

    func testOversizedSnapshotIsTrimmedUnderBudgetAndDeclaresOmissions() {
        // A large candle blob forces the budgeter to trim options first,
        // then levels, before strategy policy.
        var snapshot = makeSnapshot(levelCount: 40)
        let hugeCandles = JSONValue.array((0..<400).map { _ in
            .object(["o": .number(1), "h": .number(2), "l": .number(0.5), "c": .number(1.5), "v": .number(1000)])
        })
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

    func testDeterministic() {
        let snapshot = makeSnapshot()
        let first = ContextBudgeter.build(from: snapshot).text
        let second = ContextBudgeter.build(from: snapshot).text
        XCTAssertEqual(first, second)
    }
}
