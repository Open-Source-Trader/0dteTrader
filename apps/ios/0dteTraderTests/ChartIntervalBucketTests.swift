import XCTest
@testable import ZeroDTETrader

/// Bucket-start math must match the server's candle-aggregation and the
/// desktop ChartStore — same fixture epochs as candle-aggregation.spec.ts.
final class ChartIntervalBucketTests: XCTestCase {
    // 2026-07-13T00:00:00Z (a Monday)
    private let monday: TimeInterval = 1_783_900_800

    func testStandardIntervalsFloorOnEpoch() {
        // 2026-07-13T14:47:00Z
        let timestamp = monday + 14 * 3_600 + 47 * 60
        XCTAssertEqual(ChartInterval.m30.bucketStart(forEpochSeconds: timestamp), monday + 14.5 * 3_600)
        XCTAssertEqual(ChartInterval.h4.bucketStart(forEpochSeconds: timestamp), monday + 12 * 3_600)
    }

    func testWeeklyBucketsAlignToMondayNotThursdayEpoch() {
        // Friday 2026-07-17T19:59:00Z → week of Monday 2026-07-13.
        let friday = monday + 4 * 86_400 + 19 * 3_600 + 59 * 60
        XCTAssertEqual(ChartInterval.w1.bucketStart(forEpochSeconds: friday), monday)
        // Sunday 2026-07-12T23:00:00Z belongs to the previous Monday's week.
        let sunday = monday - 3_600
        XCTAssertEqual(ChartInterval.w1.bucketStart(forEpochSeconds: sunday), monday - 604_800)
    }

    func testWeeklyBucketAfterSundayMidnightOpensNewWeek() {
        let nextMondayQuote = monday + 604_800 + 30
        XCTAssertEqual(ChartInterval.w1.bucketStart(forEpochSeconds: nextMondayQuote), monday + 604_800)
    }

    func testEpochStartBelongsToWeekOfMondayDec29_1969() {
        // 1970-01-01 (Thursday) floors to Monday 1969-12-29 = -259200.
        XCTAssertEqual(ChartInterval.w1.bucketStart(forEpochSeconds: 0), -259_200)
    }
}
