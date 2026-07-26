import SwiftUI
import UIKit

/// Chart-layer color tokens: UIKit twins of the DesignSystem palette, used by
/// the DGCharts renderables and the drawing overlay.
///
/// NOTE: these belong in `DesignSystem/AppColors.swift` next to the other
/// `UIColor` twins, but the design-system foundation is frozen for this pass.
/// Move them there (and delete this extension) in a follow-up.
extension UIColor {
    /// Up candles / positive histogram bars (matches `Color.buyGreen`).
    static let chartUp = UIColor(Color.buyGreen)
    /// Down candles / negative histogram bars (matches `Color.sellRed`).
    static let chartDown = UIColor(Color.sellRed)
}

/// Chart-layer shared constants.
enum ChartStyle {
    /// Fixed colors for price overlays, shared by the chart lines and the
    /// indicator-settings legend swatches so they never drift.
    static let overlayColors: [String: UIColor] = [
        "sma": UIColor(red: 0.231, green: 0.620, blue: 1.0, alpha: 1), // #3B9EFF
        "ema": UIColor(red: 0.392, green: 0.824, blue: 1.0, alpha: 1), // #64D2FF
        "vwap": UIColor(red: 0.694, green: 0.298, blue: 0.941, alpha: 1), // #B14CF0
        "bollingerUpper": UIColor(red: 0.290, green: 0.435, blue: 0.647, alpha: 1), // #4A6FA5
        "bollingerMiddle": UIColor(red: 0.251, green: 0.796, blue: 0.878, alpha: 1), // #40CBE0
        "bollingerLower": UIColor(red: 0.290, green: 0.435, blue: 0.647, alpha: 1), // #4A6FA5
    ]

    /// Sub-pane series colors, shared with the pane renderables so the
    /// legend swatches and lines never drift. Values mirror the desktop
    /// `--chart-*` tokens (RSI amber, MACD blue/orange).
    static let paneColors: [String: UIColor] = [
        "rsi": UIColor(red: 1.0, green: 0.773, blue: 0.239, alpha: 1), // #FFC53D
        "macd": UIColor(red: 0.231, green: 0.620, blue: 1.0, alpha: 1), // #3B9EFF
        "macdSignal": UIColor(red: 1.0, green: 0.624, blue: 0.039, alpha: 1), // #FF9F0A
        "stochK": UIColor(red: 0.231, green: 0.620, blue: 1.0, alpha: 1), // #3B9EFF
        "stochD": UIColor(red: 1.0, green: 0.624, blue: 0.039, alpha: 1), // #FF9F0A
        "atr": UIColor(red: 0.251, green: 0.796, blue: 0.878, alpha: 1), // #40CBE0
    ]

    /// SwiftUI twin of an overlay color (settings-sheet legend swatches).
    static func overlayColor(for id: String) -> Color {
        Color(uiColor: overlayColors[id] ?? .systemOrange)
    }

    /// SwiftUI twin of a sub-pane color.
    static func paneColor(for id: String) -> Color {
        Color(uiColor: paneColors[id] ?? .systemOrange)
    }
}

/// Shared chart metrics (DGCharts units).
enum ChartMetrics {
    /// Candles visible in the main chart's default viewport.
    static let visibleCandles: Double = 120
    /// Volume bars are compressed into the bottom 1/5 of the pane.
    static let volumeHeightRatio: Double = 5
    static let shadowWidth: CGFloat = 0.7
    static let barSpace: CGFloat = 0.2
    static let overlayLineWidth: CGFloat = 1.2
    /// Blur on the drop shadow under a floating axis label. The scales print
    /// over the candles now, and this is what separates a digit from a wick
    /// without putting a box around it.
    static let axisLabelShadowBlur: CGFloat = 4
    /// Leading pad for SwiftUI chrome laid over the pane (the analytics error):
    /// past the price labels, which now float inside the plot at the same
    /// corner. The top-row chrome hugs the borders instead and accepts the
    /// overlap, which only ever falls on the topmost price label.
    static let overlayLeading: CGFloat = 58
    /// Bottom pad for the same chrome: past the time labels, which float along
    /// the bottom of the plot now rather than under it.
    static let overlayBottom: CGFloat = 28
    /// Corner cut on the price card.
    static let paneChamfer: CGFloat = 10

    /// Inset that seats a corner control equally off both borders and the
    /// diagonal of a chamfered corner.
    ///
    /// The bottom-right chamfer is the line `x + y = W + H - c`. A corner point
    /// `m` in from both borders sits at `(W - m, H - m)`, a perpendicular
    /// `(2m - c) / √2` from it, so equal spacing on all three edges is
    /// `m = c / (2 - √2)`. A corner rounded by `r` reaches `r` closer to the
    /// diagonal than its bounding box does, so the inset owes that back.
    /// With c = 10 and r = 4 this is 13.07pt.
    static func cornerSeat(cornerRadius: CGFloat, chamfer: CGFloat = paneChamfer) -> CGFloat {
        chamfer / (2 - sqrt(2)) - cornerRadius
    }

    /// The one description of a control parked in the pane's bottom-right
    /// corner, shared by the reset button and the placement guide's `+` handle.
    ///
    /// The two now stand in the same column, so their left and right borders
    /// have to agree exactly — and two hand-tuned constants that happen to
    /// match today are two constants that silently stop matching. Both read
    /// their width and their distance from the right border from here instead.
    /// The reset button also takes the seat as its *bottom* inset, which is
    /// what `cornerSeat` is for; the handle's vertical position is the price it
    /// is sitting at.
    static let cornerControlSize: CGFloat = 24
    static let cornerControlRadius: CGFloat = 4
    static let cornerControlInset = cornerSeat(cornerRadius: cornerControlRadius)
}

/// Cached date formatters for axis/marker time labels.
enum ChartTimeFormat {
    static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d"
        return formatter
    }()

    /// "HH:mm" for intraday intervals, "MMM d" for daily and up.
    static func string(for date: Date, intervalSeconds: TimeInterval) -> String {
        let formatter = intervalSeconds >= 86_400 ? dayFormatter : timeFormatter
        return formatter.string(from: date)
    }
}
