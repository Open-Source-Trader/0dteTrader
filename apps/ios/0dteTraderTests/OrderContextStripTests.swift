import XCTest
@testable import ZeroDTETrader

final class OrderContextStripTests: XCTestCase {
    private let contract = OptionContract(
        symbol: "QQQ260729C00669000",
        underlying: "QQQ",
        expiration: "2026-07-29",
        strike: 669,
        optionType: .call,
        bid: 1.83,
        ask: 1.87,
        last: 1.85
    )

    func testNoContractSelectedState() {
        let summary = OrderContextSummaryBuilder.build(
            selectedContract: nil,
            positions: [],
            quantity: 1,
            orderType: .mid,
            customLimitPrice: nil,
            isQuoteLoading: false
        )

        XCTAssertEqual(summary.kind, .empty)
        XCTAssertEqual(summary.primary, "No contract selected")
        XCTAssertEqual(summary.secondary, "Pick an expiration and strike to preview risk")
    }

    func testContractSelectedWithQuoteShowsOrderPreview() {
        let summary = OrderContextSummaryBuilder.build(
            selectedContract: contract,
            positions: [],
            quantity: 1,
            orderType: .mid,
            customLimitPrice: nil,
            isQuoteLoading: false
        )

        XCTAssertEqual(summary.kind, .orderPreview)
        XCTAssertEqual(summary.primary, "QQQ 669C · Qty 1")
        XCTAssertEqual(summary.secondary, "Debit $185.00 · Max loss $185.00 · Spread $0.04")
        XCTAssertEqual(summary.tertiary, "Breakeven $670.85")
        XCTAssertEqual(summary.financialSummary?.contract, "QQQ 669C")
        XCTAssertEqual(summary.financialSummary?.quantity, "1")
        XCTAssertEqual(summary.financialSummary?.debit, "$185.00")
        XCTAssertEqual(summary.financialSummary?.breakeven, "$670.85")
        XCTAssertEqual(summary.financialSummary?.maxLoss, "$185.00")
    }

    func testQuoteLoadingState() {
        let summary = OrderContextSummaryBuilder.build(
            selectedContract: contract,
            positions: [],
            quantity: 1,
            orderType: .custom,
            customLimitPrice: nil,
            isQuoteLoading: true
        )

        XCTAssertEqual(summary.kind, .loading)
        XCTAssertEqual(summary.primary, "QQQ 669C · Qty 1")
        XCTAssertEqual(summary.secondary, "Refreshing quote…")
    }

    func testQuoteUnavailableWarningState() {
        let unavailable = OptionContract(
            symbol: "QQQ260729C00669000",
            underlying: "QQQ",
            expiration: "2026-07-29",
            strike: 669,
            optionType: .call,
            bid: 0,
            ask: 0,
            last: 0
        )

        let summary = OrderContextSummaryBuilder.build(
            selectedContract: unavailable,
            positions: [],
            quantity: 1,
            orderType: .mid,
            customLimitPrice: nil,
            isQuoteLoading: false,
            warning: "Unexpected response from server."
        )

        XCTAssertEqual(summary.kind, .quoteUnavailable)
        XCTAssertEqual(summary.secondary, "Quote unavailable")
        XCTAssertEqual(summary.warning, "Options Structure unavailable: Unexpected response from server.")
    }

    func testOpenPositionReplacesOrderPreviewWithPositivePnl() {
        let summary = OrderContextSummaryBuilder.build(
            selectedContract: contract,
            positions: [position(unrealizedPnl: 24, markPrice: 2.09)],
            quantity: 1,
            orderType: .mid,
            customLimitPrice: nil,
            isQuoteLoading: false
        )

        XCTAssertEqual(summary.kind, .position)
        XCTAssertEqual(summary.primary, "QQQ 669C · Qty 1")
        XCTAssertEqual(summary.secondary, "+$24.00 · +13%")
        XCTAssertEqual(summary.tertiary, "Entry $1.85 · Mark $2.09 · No stop/target")
        XCTAssertEqual(summary.pnlTone, .positive)
    }

    func testOpenPositionNegativePnlUsesLossTone() {
        let summary = OrderContextSummaryBuilder.build(
            selectedContract: contract,
            positions: [position(unrealizedPnl: -18, markPrice: 1.67)],
            quantity: 1,
            orderType: .mid,
            customLimitPrice: nil,
            isQuoteLoading: false
        )

        XCTAssertEqual(summary.kind, .position)
        XCTAssertEqual(summary.secondary, "-$18.00 · -10%")
        XCTAssertEqual(summary.pnlTone, .negative)
    }

    func testWarningDoesNotDoublePrefixOptionsStructureMessage() {
        let summary = OrderContextSummaryBuilder.build(
            selectedContract: nil,
            positions: [],
            quantity: 1,
            orderType: .mid,
            customLimitPrice: nil,
            isQuoteLoading: false,
            warning: "Options Structure expired: stale snapshot"
        )

        XCTAssertEqual(summary.warning, "Options Structure expired: stale snapshot")
    }

    func testTradePanelKeepsSummaryAboveSafeAreaDock() throws {
        let panel = try sourceFile("0dteTrader/Features/Trade/TradePanelView.swift")
        let screen = try sourceFile("0dteTrader/Features/Trade/TradeScreenView.swift")
        let stripIndex = try XCTUnwrap(panel.range(of: "OrderContextStripView")?.lowerBound)
        let dockIndex = try XCTUnwrap(screen.range(of: ".safeAreaInset(edge: .bottom")?.lowerBound)

        XCTAssertLessThan(stripIndex, panel.endIndex)
        XCTAssertLessThan(dockIndex, screen.endIndex)
        XCTAssertFalse(panel.contains("TradeActionButton(title: \"SELL\""))
        XCTAssertFalse(panel.contains("TradeActionButton(title: \"BUY\""))
    }

    func testOptionsErrorsNoLongerOverlayChart() throws {
        let source = try sourceFile("0dteTrader/Features/Chart/ChartView.swift")

        XCTAssertFalse(source.contains("Options Structure unavailable:"))
        XCTAssertFalse(source.contains("optionsAnalyticsErrorText"))
    }

    func testSafeAreaPaddingBelongsToActionDock() throws {
        let screen = try sourceFile("0dteTrader/Features/Trade/TradeScreenView.swift")
        let panel = try sourceFile("0dteTrader/Features/Trade/TradePanelView.swift")
        let floatingDock = try sourceFile("0dteTrader/Features/Trade/FloatingTradeButtons.swift")

        XCTAssertTrue(screen.contains(".safeAreaInset(edge: .bottom, spacing: 0)"))
        XCTAssertFalse(screen.contains("safeAreaInsets.bottom"))
        XCTAssertFalse(screen.contains("bottomSafeAreaInset"))
        XCTAssertFalse(screen.contains(".ignoresSafeArea(edges: .bottom)"))
        XCTAssertFalse(panel.contains("bottomSafeAreaInset"))
        XCTAssertFalse(panel.contains(".padding(.bottom, max(bottomSafeAreaInset"))
        XCTAssertFalse(screen.contains(".padding(.bottom, insetBottom)"))
        XCTAssertFalse(screen.contains(".padding(.bottom, AppSpacing.lg)"))
        XCTAssertTrue(floatingDock.contains(".padding(.bottom, AppSpacing.sm)"))
        XCTAssertTrue(floatingDock.contains(".ignoresSafeArea(edges: .bottom)"))
    }

    func testSplitLayoutUsesFlexibleChartInsteadOfStalePanelFraction() throws {
        let source = try sourceFile("0dteTrader/Features/Trade/TradeScreenView.swift")

        XCTAssertTrue(source.contains("chartMinHeight"))
        XCTAssertTrue(source.contains(".frame(minHeight: Self.chartMinHeight, maxHeight: .infinity)"))
        XCTAssertTrue(source.contains(".fixedSize(horizontal: false, vertical: true)"))
        XCTAssertFalse(source.contains("panelFractions"))
        XCTAssertFalse(source.contains(".frame(height: panelHeight)"))
        XCTAssertFalse(source.contains("chartHeight"))
    }

    func testTradePanelDoesNotClipSelectorControls() throws {
        let source = try sourceFile("0dteTrader/Features/Trade/TradePanelView.swift")

        XCTAssertFalse(source.contains(".frame(maxHeight: .infinity, alignment: .top)"))
        XCTAssertFalse(source.contains(".clipped()"))
    }

    func testNarrowContextStripTextTruncatesInsteadOfOverflowing() throws {
        let source = try sourceFile("0dteTrader/Features/Trade/OrderContextStripView.swift")

        XCTAssertTrue(source.contains(".lineLimit(1)"))
        XCTAssertTrue(source.contains(".truncationMode(.tail)"))
        XCTAssertTrue(source.contains(".frame(maxWidth: .infinity"))
    }

    private func sourceFile(_ relativePath: String) throws -> String {
        let testsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let url = testsDirectory.deletingLastPathComponent().appendingPathComponent(relativePath)
        return try String(contentsOf: url, encoding: .utf8)
    }

    private func position(unrealizedPnl: Double, markPrice: Double) -> Position {
        Position(
            symbol: contract.symbol,
            assetClass: .option,
            quantity: 1,
            avgPrice: 1.85,
            markPrice: markPrice,
            unrealizedPnl: unrealizedPnl,
            multiplier: 100,
            underlyingEntryPrice: nil
        )
    }
}
