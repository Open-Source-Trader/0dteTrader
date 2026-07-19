import SwiftUI
import UIKit

/// Neon-HUD palette (dark-only theme; the root view forces dark). The dynamic
/// wrappers are kept so call sites don't change — both branches resolve to the
/// same HUD values. Mirrored in apps/desktop/src/design/tokens.css.
extension Color {
    /// Near-black navy. Main screen background. #050A14
    static let appBackground = Color(
        uiColor: UIColor(red: 0.020, green: 0.039, blue: 0.078, alpha: 1)
    )

    /// Card / strip surface above the background. #081020
    static let appSurface = Color(
        uiColor: UIColor(red: 0.031, green: 0.063, blue: 0.125, alpha: 1)
    )

    /// Slightly raised surface for interactive chips. #0C1830
    static let appSurfaceElevated = Color(
        uiColor: UIColor(red: 0.047, green: 0.094, blue: 0.188, alpha: 1)
    )

    /// Primary action green (Buy / up-candles / bid). #22E06A
    static let buyGreen = Color(
        uiColor: UIColor(red: 0.133, green: 0.878, blue: 0.416, alpha: 1)
    )

    /// Primary action red (Sell / down-candles / ask / errors). #FF3B4E
    static let sellRed = Color(
        uiColor: UIColor(red: 1.0, green: 0.231, blue: 0.306, alpha: 1)
    )

    /// Neon app accent (strokes, links, selected states). #3B9EFF
    static let appAccent = Color(
        uiColor: UIColor(red: 0.231, green: 0.620, blue: 1.0, alpha: 1)
    )

    /// Button-fill variants: white text on these passes WCAG AA (≥4.5:1).
    /// Use for button backgrounds; keep the bright tokens above for
    /// text/icon accents on app surfaces.
    static let buyGreenFill = Color(
        uiColor: UIColor(red: 0.059, green: 0.486, blue: 0.243, alpha: 1) // #0F7C3E
    )

    static let sellRedFill = Color(
        uiColor: UIColor(red: 0.761, green: 0.122, blue: 0.188, alpha: 1) // #C21F30
    )

    static let appAccentFill = Color(
        uiColor: UIColor(red: 0.122, green: 0.435, blue: 0.878, alpha: 1) // #1F6FE0
    )

    /// Warning / caution amber (PRACTICE badge, risk notices). #FFC53D
    static let appWarning = Color(
        uiColor: UIColor(red: 1.0, green: 0.773, blue: 0.239, alpha: 1)
    )

    /// Neon stroke at panel-border strength. Passes the WCAG 3:1
    /// non-text contrast floor on appBackground.
    static let appBorder = Color(
        uiColor: UIColor(red: 0.180, green: 0.561, blue: 1.0, alpha: 0.45)
    )

    /// P&L / price-change colors for text on app surfaces. These are the
    /// canonical P&L tokens — do not use `buyGreen`/`sellRed` for P&L text.
    static let pnlPositive = Color(
        uiColor: UIColor(red: 0.133, green: 0.878, blue: 0.416, alpha: 1) // #22E06A
    )
    static let pnlNegative = Color(
        uiColor: UIColor(red: 1.0, green: 0.231, blue: 0.306, alpha: 1) // #FF3B4E
    )

    // MARK: HUD chrome

    /// Panel fill for chamfered HUD cards (slightly translucent). #081020 @ 0.92
    static let hudPanel = Color(
        uiColor: UIColor(red: 0.031, green: 0.063, blue: 0.125, alpha: 0.92)
    )
    /// 1–2px neon card stroke. #2E8FFF
    static let hudStroke = Color(
        uiColor: UIColor(red: 0.180, green: 0.561, blue: 1.0, alpha: 1)
    )
    /// Outer glow color for cards/buttons (use as shadow color).
    static let hudGlow = Color(
        uiColor: UIColor(red: 0.180, green: 0.561, blue: 1.0, alpha: 0.5)
    )
    /// Amber HUD accent (PRACTICE badge outline). #FFC53D
    static let hudAmber = Color(
        uiColor: UIColor(red: 1.0, green: 0.773, blue: 0.239, alpha: 1)
    )
    /// Inner top-edge highlight for the 3D bevel feel.
    static let hudInnerHighlight = Color(
        uiColor: UIColor(red: 0.627, green: 0.824, blue: 1.0, alpha: 0.22)
    )
}

/// UIKit twins for the dynamic tokens above (chart layers, drawing overlay).
extension UIColor {
    static let appAccent = UIColor(Color.appAccent)
    static let appAccentFill = UIColor(Color.appAccentFill)
    static let appWarning = UIColor(Color.appWarning)
    static let hudStroke = UIColor(Color.hudStroke)
    static let hudAxisLabel = UIColor(red: 0.549, green: 0.706, blue: 0.922, alpha: 0.7)
}
