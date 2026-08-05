import Foundation

/// Mid-price calculation for limit-at-mid orders (PRD FR-17).
/// The server recomputes this from live bid/ask at submission time; the client
/// value is advisory (display + confirmation only).
enum PriceMath {
    /// Ceiling on any option price this app will quote or resolve, in dollars
    /// per share — two orders of magnitude above any listed premium. Mirrors
    /// MAX_OPTION_PRICE in @0dtetrader/shared-types: finiteness alone is not
    /// enough, since two FINITE sides can still overflow midpoint arithmetic.
    /// Readiness (`hasTradeableQuote`) and this helper bound their inputs
    /// here, so a book that reads as tradeable always yields a finite,
    /// in-range midpoint.
    static let maxOptionPrice: Double = 100_000

    /// `(bid + ask) / 2` rounded to `precision` decimal places (default: pennies).
    /// Nil when the quote is unusable (zero/negative side, crossed spread, NaN,
    /// ±inf), mirroring the server's computeMid validation; a locked market is
    /// allowed. A midpoint this returns is always finite.
    static func midPrice(bid: Double, ask: Double, precision: Int = 2) -> Double? {
        // Finiteness before any arithmetic: a feed glitch can deliver ±inf,
        // and `bid > 0` alone would wave +inf straight into midpoint math.
        guard bid.isFinite, ask.isFinite, bid > 0, ask > 0, bid <= ask,
              ask <= Self.maxOptionPrice else { return nil }
        let factor = pow(10.0, Double(precision))
        let mid = (((bid + ask) / 2) * factor).rounded() / factor
        // The sum or the scale-for-rounding can still overflow to inf on
        // absurd-but-finite quotes; refuse that rather than return it.
        return mid.isFinite ? mid : nil
    }
}
