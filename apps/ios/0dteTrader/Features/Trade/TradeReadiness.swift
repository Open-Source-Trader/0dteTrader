import Foundation

/// The one answer to "may an order be placed right now?" — every order-entry
/// surface (the split panel's Buy/Sell, the fullscreen floating buttons, and
/// chart-order placement) consumes these rather than re-deriving its own
/// gate, so the surfaces cannot drift apart the way `selectedContract != nil`
/// checks once did. Pure, so the whole matrix is unit-testable.
enum TradeReadiness {
    /// A contract exists AND carries a quote an order could be priced from.
    /// Selection alone is not readiness: a CURR leg synthesized from its OCC
    /// symbol is "selected" long before its expiration's contracts load, and
    /// trading it would price off a 0.00 display.
    static func hasTradeableContract(_ contract: OptionContract?) -> Bool {
        contract?.hasTradeableQuote == true
    }

    /// The Buy/Sell gate. `locked` folds the trading lock and a missing
    /// provider configuration together (the screen already merges them);
    /// `canArm` is the pricing completeness check (`.custom` with nothing
    /// typed has no price to send — a typed custom price does NOT bypass the
    /// quote check, since it changes the requested price, not whether the
    /// contract is a validated, quoted option); `pricingFieldBlocking` is
    /// true while the custom-price keyboard is up over the buttons.
    static func canTrade(
        contract: OptionContract?,
        locked: Bool,
        canArm: Bool,
        pricingFieldBlocking: Bool = false
    ) -> Bool {
        hasTradeableContract(contract) && !locked && canArm && !pricingFieldBlocking
    }

    /// The chart-order placement gate (tap-to-place guide and its gestures).
    /// No `canArm` term: chart orders carry their own price and quantity, so
    /// the ticket's pricing state is irrelevant — but an unquoted contract
    /// and the trading lock block placement exactly as they block Buy/Sell.
    static func canPlaceChartOrder(contract: OptionContract?, locked: Bool) -> Bool {
        hasTradeableContract(contract) && !locked
    }
}
