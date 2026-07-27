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
                    chevrons(systemImage: "chevron.down")
                }
                Text(title)
                    .font(.hudButton)
                    .kerning(1)
                if !isSell {
                    chevrons(systemImage: "chevron.up")
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

    /// The pair of decorative arrows flanking the label: down on SELL, up on
    /// BUY, because the direction the button is betting on is vertical and the
    /// sideways pair it inherited from the mockup said nothing.
    ///
    /// SF Symbols rather than `❮❮`/`❯❯`: the display font has no vertical
    /// equivalent of those glyphs, and `⌃`/`⌄` fall back to a substituted face
    /// at this size. Overlapped slightly so the two read as one chevron stack.
    private func chevrons(systemImage: String) -> some View {
        HStack(spacing: -1) {
            Image(systemName: systemImage)
            Image(systemName: systemImage)
        }
        .font(.system(size: 9, weight: .bold))
        .opacity(0.55)
        .accessibilityHidden(true)
    }
}

/// Small chamfered button used for quantity quick-steppers (1 / 5 / 10).
/// Hit target is at least 44pt per HIG; the trade panel's density tiers
/// shrink it (desktop parity: .quick-chip padding shrinks when dense).
struct QuickChipButton: View {
    let title: String
    /// The drawn chip's height; the touch target is grown back separately.
    var minHeight: CGFloat = 44
    var touchHeight: CGFloat = 44
    let action: () -> Void

    var body: some View {
        Button {
            Haptics.selection()
            action()
        } label: {
            Text(title)
                .font(.chipLabel)
                .foregroundStyle(Color.secondary)
                .padding(.horizontal, AppSpacing.md)
                .frame(minWidth: 44, minHeight: minHeight)
                .background {
                    HudPanelShape(chamfer: 6)
                        .fill(Color.hudPanel)
                        .overlay {
                            HudPanelShape(chamfer: 6)
                                .strokeBorder(Color.hudStroke.opacity(0.35), lineWidth: 1)
                        }
                }
                // The drawn chip is the stepper's height now, which is under
                // 44pt at every density. The target is grown back around it
                // rather than by growing the box, exactly as the stepper does —
                // the slack falls on the row's own padding, which nothing else
                // claims.
                .frame(minHeight: touchHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(AppPressStyle())
    }
}
