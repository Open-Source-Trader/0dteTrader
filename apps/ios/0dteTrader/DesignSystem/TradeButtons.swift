import SwiftUI

/// Large Buy/Sell action button with haptic feedback: chamfered double-frame
/// HUD chrome with baked glow (HudActionButtonStyle). Hit target is at least
/// 52pt tall per quick-trade ergonomics. Pass the bright accent tokens
/// (`Color.buyGreen` / `Color.sellRed`) as `color` — the label renders in the
/// accent over a translucent tint, not white-on-fill.
struct TradeActionButton: View {
    let title: String
    let color: Color
    var isEnabled: Bool = true
    let action: () -> Void

    private var isSell: Bool { title.localizedCaseInsensitiveContains("sell") }

    var body: some View {
        Button {
            Haptics.impact(.medium)
            action()
        } label: {
            HStack(spacing: AppSpacing.sm) {
                if isSell {
                    Text("❮❮")
                        .font(.caption2)
                        .opacity(0.55)
                        .accessibilityHidden(true)
                }
                Text(title)
                    .font(.hudButton)
                    .kerning(1)
                if !isSell {
                    Text("❯❯")
                        .font(.caption2)
                        .opacity(0.55)
                        .accessibilityHidden(true)
                }
            }
            .foregroundStyle(color)
            .shadow(color: color.opacity(0.6), radius: 6)
            .frame(maxWidth: .infinity, minHeight: 52)
            .contentShape(Rectangle())
            .opacity(isEnabled ? 1 : AppOpacity.dimmedAction)
        }
        .buttonStyle(HudActionButtonStyle(accent: color.opacity(isEnabled ? 1 : AppOpacity.dimmedAction)))
        .disabled(!isEnabled)
        .accessibilityLabel(title)
        .accessibilityHint(isEnabled
            ? "Arms an order ticket with the current defaults and opens confirmation"
            : "Unavailable. Select a contract first.")
    }
}

/// Small chamfered button used for quantity quick-steppers (1 / 5 / 10).
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
                .foregroundStyle(Color.appAccent)
                .padding(.horizontal, AppSpacing.md)
                .frame(minWidth: 44, minHeight: 44)
                .background {
                    HudPanelShape(chamfer: 6)
                        .fill(Color.hudPanel)
                        .overlay {
                            HudPanelShape(chamfer: 6)
                                .strokeBorder(Color.hudStroke.opacity(0.35), lineWidth: 1)
                        }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(AppPressStyle())
    }
}
