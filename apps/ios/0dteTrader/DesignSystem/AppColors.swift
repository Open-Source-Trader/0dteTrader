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

    /// Button-fill variants: white text on these passes WCAG AA (≥4.5:1).
    /// Use for button backgrounds; keep the bright tokens above for
    /// text/icon accents on app surfaces.
    static let buyGreenFill = Color(
        uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.055, green: 0.486, blue: 0.227, alpha: 1) // #0E7C3A — white 5.30:1
                : UIColor(red: 0.039, green: 0.420, blue: 0.196, alpha: 1) // #0A6B32
        }
    )

    static let sellRedFill = Color(
        uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.776, green: 0.157, blue: 0.188, alpha: 1) // #C62830 — white 5.60:1
                : UIColor(red: 0.690, green: 0.125, blue: 0.157, alpha: 1) // #B02028
        }
    )

    static let appAccentFill = Color(
        uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.184, green: 0.420, blue: 0.878, alpha: 1) // #2F6BE0 — white 4.88:1
                : UIColor(red: 0.145, green: 0.376, blue: 0.784, alpha: 1) // #2560C8
        }
    )

    /// Warning / caution accents (e.g. risk notices).
    static let appWarning = Color(uiColor: .systemOrange)

    /// 3.26:1 on appBackground — passes the WCAG 3:1 non-text contrast floor.
    static let appBorder = Color(
        uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(white: 1, alpha: 0.36)
                : UIColor(white: 0, alpha: 0.24)
        }
    )

    /// P&L / price-change colors for text on app surfaces. These are the
    /// canonical P&L tokens — do not use `buyGreen`/`sellRed` for P&L text.
    static let pnlPositive = Color(uiColor: .systemGreen)
    static let pnlNegative = Color(uiColor: .systemRed)
}

/// UIKit twins for the dynamic tokens above (chart layers, drawing overlay).
extension UIColor {
    static let appAccent = UIColor(Color.appAccent)
    static let appAccentFill = UIColor(Color.appAccentFill)
    static let appWarning = UIColor(Color.appWarning)
}
