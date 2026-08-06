import XCTest
@testable import ZeroDTETrader

final class AutoContractScorerTests: XCTestCase {
    private struct Fixture: Decodable {
        let tolerance: Double
        let cases: [Case]
    }

    private struct Case: Decodable {
        let id: String
        let serverTime: String
        let request: AutoScoringRequest
        let preferences: AutoScoringPreferences
        let candidates: [AutoScoringCandidate]
        let expected: Expected
    }

    private struct Expected: Decodable {
        let rankings: [ExpectedRanking]
        let exclusions: [ExpectedExclusion]
        let selectedSymbol: String?
        let noPass: Bool
        let requiresConfirmation: Bool
    }

    private struct ExpectedRanking: Decodable {
        let rank: Int
        let symbol: String
        let score: Double
        let summary: String
        let mid: Double
        let spreadBps: Double
        let premiumDollars: Double
        let atmDistance: Double
        let normalized: AutoScoringContributions
        let weighted: AutoScoringContributions
    }

    private struct ExpectedExclusion: Decodable {
        let symbol: String
        let reason: AutoScoringExclusionReason
    }

    func testEverySharedGoldenCaseMatchesExactlyWithinTolerance() throws {
        let fixture = try loadFixture()
        XCTAssertGreaterThanOrEqual(fixture.cases.count, 9)

        for testCase in fixture.cases {
            let now = try XCTUnwrap(ISO8601DateFormatter.fractional.date(from: testCase.serverTime))
            let actual = try AutoContractScorer.score(
                request: testCase.request,
                preferences: testCase.preferences,
                candidates: testCase.candidates,
                serverTime: now
            )

            XCTAssertEqual(actual.selectedSymbol, testCase.expected.selectedSymbol, testCase.id)
            XCTAssertEqual(actual.noPass, testCase.expected.noPass, testCase.id)
            XCTAssertEqual(actual.requiresConfirmation, testCase.expected.requiresConfirmation, testCase.id)
            XCTAssertEqual(actual.exclusions, testCase.expected.exclusions.map {
                AutoScoringExclusion(symbol: $0.symbol, reason: $0.reason)
            }, testCase.id)
            XCTAssertEqual(actual.rankings.count, testCase.expected.rankings.count, testCase.id)

            for (ranking, expected) in zip(actual.rankings, testCase.expected.rankings) {
                XCTAssertEqual(ranking.rank, expected.rank, testCase.id)
                XCTAssertEqual(ranking.candidate.symbol, expected.symbol, testCase.id)
                XCTAssertEqual(ranking.rationale.summary, expected.summary, testCase.id)
                assertClose(ranking.score, expected.score, fixture.tolerance, testCase.id)
                assertClose(ranking.rationale.mid, expected.mid, fixture.tolerance, testCase.id)
                assertClose(ranking.rationale.spreadBps, expected.spreadBps, fixture.tolerance, testCase.id)
                assertClose(
                    ranking.rationale.premiumDollars,
                    expected.premiumDollars,
                    fixture.tolerance,
                    testCase.id
                )
                assertClose(ranking.rationale.atmDistance, expected.atmDistance, fixture.tolerance, testCase.id)
                assertContributions(
                    ranking.rationale.normalized,
                    expected.normalized,
                    fixture.tolerance,
                    testCase.id
                )
                assertContributions(
                    ranking.rationale.weighted,
                    expected.weighted,
                    fixture.tolerance,
                    testCase.id
                )
            }
        }
    }

    func testNumericPresetsMatchThePublicContract() {
        XCTAssertEqual(AutoScoringPreferences.conservative.targetAbsDelta, 0.25)
        XCTAssertEqual(AutoScoringPreferences.conservative.strikeRungs, 5)
        XCTAssertEqual(AutoScoringPreferences.conservative.maxSpreadBps, 500)
        XCTAssertEqual(AutoScoringPreferences.conservative.maxPremiumDollars, 250)
        XCTAssertEqual(AutoScoringPreferences.conservative.minOpenInterest, 100)
        XCTAssertEqual(AutoScoringPreferences.conservative.gammaMode, .avoid)

        XCTAssertEqual(AutoScoringPreferences.aggressive.targetAbsDelta, 0.4)
        XCTAssertEqual(AutoScoringPreferences.aggressive.strikeRungs, 8)
        XCTAssertEqual(AutoScoringPreferences.aggressive.maxSpreadBps, 1_000)
        XCTAssertEqual(AutoScoringPreferences.aggressive.maxPremiumDollars, 500)
        XCTAssertEqual(AutoScoringPreferences.aggressive.minOpenInterest, 25)
        XCTAssertEqual(AutoScoringPreferences.aggressive.gammaMode, .seek)
    }

    private func loadFixture() throws -> Fixture {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = root.appendingPathComponent("packages/shared-types/fixtures/auto-scoring-v1.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    private func assertContributions(
        _ actual: AutoScoringContributions,
        _ expected: AutoScoringContributions,
        _ tolerance: Double,
        _ message: String
    ) {
        assertClose(actual.delta, expected.delta, tolerance, message)
        assertClose(actual.spread, expected.spread, tolerance, message)
        assertClose(actual.openInterest, expected.openInterest, tolerance, message)
        assertClose(actual.gamma, expected.gamma, tolerance, message)
        assertClose(actual.iv, expected.iv, tolerance, message)
    }

    private func assertClose(_ actual: Double, _ expected: Double, _ tolerance: Double, _ message: String) {
        XCTAssertEqual(actual, expected, accuracy: tolerance, message)
    }
}

private extension ISO8601DateFormatter {
    static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
