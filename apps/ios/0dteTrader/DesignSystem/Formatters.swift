import Foundation

/// Shared display formatting for prices, strikes and P&L.
enum Format {
    private static let priceFormatter: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.minimumFractionDigits = 2
        f.maximumFractionDigits = 2
        f.groupingSeparator = ","
        f.usesGroupingSeparator = true
        return f
    }()

    /// Thousands-grouped so large prices stay glanceable (`6,543.25`).
    static func price(_ value: Double, fractionDigits: Int = 2) -> String {
        priceFormatter.minimumFractionDigits = fractionDigits
        priceFormatter.maximumFractionDigits = fractionDigits
        return priceFormatter.string(from: NSNumber(value: value))
            ?? String(format: "%.\(fractionDigits)f", value)
    }

    /// `+1.24` / `-0.87` style signed values for P&L.
    static func signedPrice(_ value: Double, fractionDigits: Int = 2) -> String {
        String(format: "%+.\(fractionDigits)f", value)
    }

    /// Option strikes: trims to at most 2 fraction digits (`503`, `502.5`).
    static func strike(_ value: Double) -> String {
        if value.rounded() == value {
            return String(format: "%.0f", value)
        }
        return String(format: "%.2f", value)
    }

    /// `+2` / `-1` signed position quantities.
    static func signedQuantity(_ value: Int) -> String {
        value > 0 ? "+\(value)" : "\(value)"
    }
}
