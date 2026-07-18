import SwiftUI

/// Large, high-contrast Buy/Sell action button with haptic feedback.
/// Hit target is at least 52pt tall per quick-trade ergonomics.
/// Pass an AA fill token (`Color.buyGreenFill` / `Color.sellRedFill`) as
/// `color` — the bright text tokens fail contrast under a white label.
struct TradeActionButton: View {
    let title: String
    let color: Color
    var isEnabled: Bool = true
    let action: () -> Void

    var body: some View {
        Button {
            Haptics.impact(.medium)
            action()
        } label: {
            Text(title)
                .font(.headline)
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, minHeight: 52)
                .background(color)
                .clipShape(RoundedRectangle(cornerRadius: AppRadius.lg, style: .continuous))
                .contentShape(Rectangle())
                .opacity(isEnabled ? 1 : AppOpacity.disabled)
        }
        .buttonStyle(AppPressStyle())
        .disabled(!isEnabled)
        .accessibilityLabel(title)
        .accessibilityHint(isEnabled
            ? "Arms an order ticket with the current defaults and opens confirmation"
            : "Unavailable. Select a contract first.")
    }
}

/// Small capsule button used for quantity quick-steppers (1 / 5 / 10).
/// Hit target is at least 44pt per HIG.
struct QuickChipButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button {
            Haptics.selection()
            action()
        } label: {
            Text(title)
                .font(.chipLabel)
                .foregroundStyle(.primary)
                .padding(.horizontal, AppSpacing.md)
                .frame(minWidth: 44, minHeight: 44)
                .background(Color.appSurfaceElevated)
                .clipShape(Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(AppPressStyle())
    }
}
