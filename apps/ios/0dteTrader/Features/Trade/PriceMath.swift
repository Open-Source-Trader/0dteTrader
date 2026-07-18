import Foundation

/// Mid-price calculation for limit-at-mid orders (PRD FR-17).
/// The server recomputes this from live bid/ask at submission time; the client
/// value is advisory (display + confirmation only).
enum PriceMath {
    /// `(bid + ask) / 2` rounded to `precision` decimal places (default: pennies).
    /// Nil when the quote is unusable (zero/negative side, crossed spread, NaN),
    /// mirroring the server's computeMid validation; a locked market is allowed.
    static func midPrice(bid: Double, ask: Double, precision: Int = 2) -> Double? {
        guard bid > 0, ask > 0, bid <= ask else { return nil }
        let factor = pow(10.0, Double(precision))
        return (((bid + ask) / 2) * factor).rounded() / factor
    }
}
