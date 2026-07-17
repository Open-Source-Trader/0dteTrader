import SwiftUI
import UIKit

/// Dark-mode-first palette (PRD NFR-3). Every color resolves per user interface
/// style, so light mode remains fully supported.
extension Color {
    /// Near-black in dark, soft gray in light. Main screen background.
    static let appBackground = Color(
        uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.043, green: 0.047, blue: 0.063, alpha: 1)
                : UIColor(red: 0.961, green: 0.965, blue: 0.976, alpha: 1)
        }
    )

    /// Card / strip surface above the background.
    static let appSurface = Color(
        uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.102, green: 0.110, blue: 0.141, alpha: 1)
                : UIColor.white
        }
    )

    /// Slightly raised surface for interactive chips.
    static let appSurfaceElevated = Color(
        uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.157, green: 0.169, blue: 0.208, alpha: 1)
                : UIColor(red: 0.929, green: 0.937, blue: 0.953, alpha: 1)
        }
    )

    /// Primary action green (Buy / flatten-profit positive accents).
    static let buyGreen = Color(
        uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.098, green: 0.722, blue: 0.357, alpha: 1)
                : UIColor(red: 0.078, green: 0.612, blue: 0.302, alpha: 1)
        }
    )

    /// Primary action red (Sell / destructive).
    static let sellRed = Color(
        uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.882, green: 0.227, blue: 0.263, alpha: 1)
                : UIColor(red: 0.792, green: 0.173, blue: 0.208, alpha: 1)
        }
    )

    /// Neutral app accent (links, toggles, selected states).
    static let appAccent = Color(
        uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.337, green: 0.561, blue: 0.969, alpha: 1)
                : UIColor(red: 0.192, green: 0.427, blue: 0.878, alpha: 1)
        }
    )

    static let appBorder = Color(uiColor: .separator)

    /// P&L / price-change colors for text on app surfaces.
    static let pnlPositive = Color(uiColor: .systemGreen)
    static let pnlNegative = Color(uiColor: .systemRed)
}
