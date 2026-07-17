import Foundation

/// Mid-price calculation for limit-at-mid orders (PRD FR-17).
/// The server recomputes this from live bid/ask at submission time; the client
/// value is advisory (display + confirmation only).
enum PriceMath {
    /// `(bid + ask) / 2` rounded to `precision` decimal places (default: pennies).
    static func midPrice(bid: Double, ask: Double, precision: Int = 2) -> Double {
        let factor = pow(10.0, Double(precision))
        return (((bid + ask) / 2) * factor).rounded() / factor
    }
}
