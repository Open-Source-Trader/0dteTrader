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
