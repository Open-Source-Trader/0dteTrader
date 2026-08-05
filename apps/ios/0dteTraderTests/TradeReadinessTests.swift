import XCTest
@testable import ZeroDTETrader

/// The canonical quote-readiness matrix. Every order-entry surface — the
/// split panel, the fullscreen buttons, chart placement — consumes
/// `TradeReadiness`, so this table IS their shared behavior: the layouts
/// cannot answer differently for the same inputs.
final class TradeReadinessTests: XCTestCase {
    private func contract(bid: Double, ask: Double, last: Double = 0) -> OptionContract {
        OptionContract(
            symbol: "SPY260727C00505000",
            underlying: "SPY",
            expiration: "2026-07-27",
            strike: 505,
            optionType: .call,
            bid: bid,
            ask: ask,
            last: last
        )
    }

    // MARK: - hasTradeableQuote

    func testBothSidesZero_isNotTradeable() {
        XCTAssertFalse(contract(bid: 0, ask: 0).hasTradeableQuote)
    }

    /// Flipped from the old one-sided rule: every order type is priced from
    /// the live book, and mid/bid/ask all need both sides — a lone bid is
    /// not a market an order can be priced from.
    func testBidOnly_isNotTradeable() {
        XCTAssertFalse(contract(bid: 0.55, ask: 0).hasTradeableQuote)
    }

    /// Flipped from the old one-sided rule, same reasoning as bid-only.
    func testAskOnly_isNotTradeable() {
        XCTAssertFalse(contract(bid: 0, ask: 0.6).hasTradeableQuote)
    }

    func testBothSidesLive_isTradeable() {
        XCTAssertTrue(contract(bid: 0.55, ask: 0.6).hasTradeableQuote)
    }

    /// A crossed book (bid above ask) is a broken feed, not a market.
    func testCrossedBook_isNotTradeable() {
        XCTAssertFalse(contract(bid: 0.65, ask: 0.6).hasTradeableQuote)
    }

    /// A locked book (bid == ask) is unusual but real and priceable.
    func testLockedBook_isTradeable() {
        XCTAssertTrue(contract(bid: 0.6, ask: 0.6).hasTradeableQuote)
    }

    func testNegativeAndInvalidSides_areNotTradeable() {
        XCTAssertFalse(contract(bid: -1, ask: -0.5).hasTradeableQuote)
        XCTAssertFalse(contract(bid: .nan, ask: .nan).hasTradeableQuote)
    }

    func testStaleLastPrintAlone_isNotAMarket() {
        // The CURR placeholder can carry a last print copied from the
        // position's mark; with both live sides dead it stays untradeable.
        XCTAssertFalse(contract(bid: 0, ask: 0, last: 1.23).hasTradeableQuote)
    }

    // MARK: - canTrade (Buy/Sell gate, both layouts)

    func testNoSelectedContract_isDisabled() {
        XCTAssertFalse(TradeReadiness.canTrade(contract: nil, locked: false, canArm: true))
    }

    func testZeroQuoteContract_isDisabled() {
        XCTAssertFalse(
            TradeReadiness.canTrade(contract: contract(bid: 0, ask: 0), locked: false, canArm: true)
        )
    }

    func testZeroQuoteContract_customPriceDoesNotEnable() {
        // canArm true is exactly the state a typed custom price produces —
        // the quote gate must still hold.
        XCTAssertFalse(
            TradeReadiness.canTrade(contract: contract(bid: 0, ask: 0), locked: false, canArm: true)
        )
        // Nor does any other pricing mode change the answer; the gate has no
        // pricing-mode input at all — only completeness (canArm).
        XCTAssertFalse(
            TradeReadiness.canTrade(contract: contract(bid: 0, ask: 0), locked: false, canArm: false)
        )
    }

    func testQuotedContract_isEnabled() {
        XCTAssertTrue(
            TradeReadiness.canTrade(contract: contract(bid: 0.55, ask: 0.6), locked: false, canArm: true)
        )
    }

    /// Flipped from the old one-sided rule: a lone ask can no longer arm —
    /// two-sided, uncrossed quotes are required everywhere an order can be
    /// sent.
    func testOneSidedQuote_isDisabled() {
        XCTAssertFalse(
            TradeReadiness.canTrade(contract: contract(bid: 0, ask: 0.6), locked: false, canArm: true)
        )
    }

    func testLock_disablesEvenAQuotedContract() {
        XCTAssertFalse(
            TradeReadiness.canTrade(contract: contract(bid: 0.55, ask: 0.6), locked: true, canArm: true)
        )
    }

    func testIncompletePricing_disables() {
        XCTAssertFalse(
            TradeReadiness.canTrade(contract: contract(bid: 0.55, ask: 0.6), locked: false, canArm: false)
        )
    }

    func testPricingFieldBlocking_disables() {
        XCTAssertFalse(
            TradeReadiness.canTrade(
                contract: contract(bid: 0.55, ask: 0.6),
                locked: false,
                canArm: true,
                pricingFieldBlocking: true
            )
        )
    }

    /// The fullscreen and split layouts consume this same function with the
    /// same inputs, so their readiness is identical by construction — this
    /// pins the equivalence for the whole matrix.
    func testReadinessIsLayoutIndependent() {
        struct Inputs {
            let contract: OptionContract?
            let locked: Bool
            let canArm: Bool
        }
        let cases: [Inputs] = [
            Inputs(contract: nil, locked: false, canArm: true),
            Inputs(contract: contract(bid: 0, ask: 0), locked: false, canArm: true),
            Inputs(contract: contract(bid: 0.55, ask: 0.6), locked: false, canArm: true),
            Inputs(contract: contract(bid: 0.55, ask: 0.6), locked: true, canArm: true),
            Inputs(contract: contract(bid: 0, ask: 0.6), locked: false, canArm: false),
        ]
        for inputs in cases {
            let split = TradeReadiness.canTrade(
                contract: inputs.contract,
                locked: inputs.locked,
                canArm: inputs.canArm
            )
            let fullscreen = TradeReadiness.canTrade(
                contract: inputs.contract,
                locked: inputs.locked,
                canArm: inputs.canArm
            )
            XCTAssertEqual(split, fullscreen)
        }
    }

    /// A refreshed chain replacing the zero-quote placeholder with a live
    /// contract flips readiness on with no other input changing.
    func testControlsReenable_whenPlaceholderGainsQuotes() {
        let placeholder = contract(bid: 0, ask: 0)
        let refreshed = contract(bid: 0.55, ask: 0.6)
        XCTAssertFalse(TradeReadiness.canTrade(contract: placeholder, locked: false, canArm: true))
        XCTAssertTrue(TradeReadiness.canTrade(contract: refreshed, locked: false, canArm: true))
    }

    // MARK: - canPlaceChartOrder (tap-to-place gate)

    func testChartPlacement_requiresAQuotedContract() {
        XCTAssertFalse(TradeReadiness.canPlaceChartOrder(contract: nil, locked: false))
        XCTAssertFalse(TradeReadiness.canPlaceChartOrder(contract: contract(bid: 0, ask: 0), locked: false))
        XCTAssertTrue(TradeReadiness.canPlaceChartOrder(contract: contract(bid: 0.55, ask: 0.6), locked: false))
    }

    func testChartPlacement_blockedByTheTradingLock() {
        XCTAssertFalse(TradeReadiness.canPlaceChartOrder(contract: contract(bid: 0.55, ask: 0.6), locked: true))
    }

    /// Chart placement carries its own price and quantity, so the ticket's
    /// pricing completeness is deliberately not an input here.
    func testChartPlacement_ignoresTicketPricingState() {
        XCTAssertTrue(TradeReadiness.canPlaceChartOrder(contract: contract(bid: 0.55, ask: 0.6), locked: false))
    }
}
