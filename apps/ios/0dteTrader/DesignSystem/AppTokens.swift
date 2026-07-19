import SwiftUI

/// Dimensional tokens: spacing, radius, elevation, motion and opacity.
/// Use these instead of inline magic values so screens stay on the 4pt grid.
enum AppSpacing {
    static let xxs: CGFloat = 2
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 20
    static let xxl: CGFloat = 24
    static let xxxl: CGFloat = 32
}

enum AppRadius {
    static let sm: CGFloat = 8
    static let md: CGFloat = 10
    static let lg: CGFloat = 12
}

enum AppElevation {
    /// Floating-toast shadow: `.shadow(color: AppElevation.toast.color, radius: AppElevation.toast.radius, y: AppElevation.toast.y)`.
    static let toast = (color: Color.black.opacity(0.4), radius: CGFloat(8), y: CGFloat(4))
}

enum AppMotion {
    /// Instant-feel feedback for press states and small toggles.
    static let quick = Animation.snappy(duration: 0.15)
    /// Default spring for appearing/disappearing UI (toasts, banners).
    static let standard = Animation.spring(response: 0.3, dampingFraction: 0.8)
}

enum AppOpacity {
    /// Uniform dim for disabled controls — dims fill and label together.
    static let disabled: Double = 0.35
    /// Softer dim for disabled SELL/BUY — the mockup keeps them clearly
    /// visible (desktop `.hud-btn:disabled` parity).
    static let dimmedAction: Double = 0.55
}

/// Shared press feedback: slight scale-down + dim on touch-down.
/// Honors Reduce Motion (scale is dropped, dim snaps instantly).
struct AppPressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(reduceMotion ? nil : AppMotion.quick, value: configuration.isPressed)
    }
}
