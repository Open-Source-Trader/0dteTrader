import Foundation
import UIKit

/// Pure presentation math for the GEX overlay, extracted so XCTest can pin
/// it (same values as GexOverlay.tsx — keep both in sync).
enum GexPresentation {
    /// "+$1.2B" / "-$800M" style notional formatting.
    static func dollarText(_ value: Double) -> String {
        let absValue = abs(value)
        let sign = value < 0 ? "-" : "+"
        switch absValue {
        case 1_000_000_000...:
            return String(format: "%@$%.1fB", sign, absValue / 1_000_000_000)
        case 1_000_000...:
            return String(format: "%@$%.1fM", sign, absValue / 1_000_000)
        case 1_000...:
            return String(format: "%@$%.0fK", sign, absValue / 1_000)
        default:
            return String(format: "%@$%.0f", sign, absValue)
        }
    }

    /// Band half-height: a quarter of the tightest strike spacing in the
    /// shown set, so bands on adjacent strikes never overlap. Falls back to
    /// a spot-relative width when there is a single strike.
    static func bandHalfHeight(strikes: [Double], spot: Double) -> Double {
        let sorted = strikes.sorted()
        var minGap = Double.infinity
        for index in 1..<sorted.count {
            let gap = sorted[index] - sorted[index - 1]
            if gap > 0, gap < minGap { minGap = gap }
        }
        if !minGap.isFinite { minGap = max(spot * 0.005, 1) }
        return minGap / 4
    }

    /// Heat-band alpha: 0.15 floor scaled by relative premium, capped.
    static func bandAlpha(intensity: Double, cap: Double) -> Double {
        min(0.15 + max(intensity, 0) * cap, cap)
    }

    static let gammaFlipColor = UIColor(red: 1, green: 214 / 255, blue: 10 / 255, alpha: 1)
    static let callWallColor = UIColor(red: 48 / 255, green: 209 / 255, blue: 88 / 255, alpha: 1)
    static let putWallColor = UIColor(red: 1, green: 69 / 255, blue: 58 / 255, alpha: 1)
    static let magnetColor = UIColor(red: 100 / 255, green: 210 / 255, blue: 1, alpha: 1)
    static let premiumColor = UIColor(red: 1, green: 159 / 255, blue: 10 / 255, alpha: 1)
}
