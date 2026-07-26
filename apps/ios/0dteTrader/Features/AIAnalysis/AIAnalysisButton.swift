import SwiftUI

/// Chamfered HUD chip sized to sit beside `HudToggleChip` in the trade panel's
/// contract row, rather than the bare glyph a navigation bar would take.
struct AIAnalysisButton: View {
    let action: () -> Void

    var body: some View {
        if #available(iOS 26, *) {
            Button {
                Haptics.selection()
                action()
            } label: {
                Image(systemName: "brain.head.profile")
                    .font(.subheadline)
                    .foregroundStyle(Color.secondary)
                    .padding(.horizontal, AppSpacing.md)
                    .frame(minHeight: 34)
                    .background {
                        HudPanelShape(chamfer: 6)
                            .fill(Color.hudPanel)
                            .overlay {
                                HudPanelShape(chamfer: 6)
                                    .strokeBorder(Color.hudStroke.opacity(0.35), lineWidth: 1.2)
                            }
                    }
                    .contentShape(Rectangle())
            }
            .buttonStyle(AppPressStyle())
            .accessibilityLabel("AI Analysis")
        }
    }
}
