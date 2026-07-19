import SwiftUI

/// Result banner for order submissions and stream events.
/// Tapping the capsule dismisses it immediately.
struct ToastView: View {
    let toast: Toast
    var onDismiss: (() -> Void)?

    private var tint: Color {
        switch toast.style {
        case .success: return Color.buyGreen
        case .error: return Color.sellRed
        case .info: return Color.appAccent
        }
    }

    private var icon: String {
        switch toast.style {
        case .success: return "checkmark.circle.fill"
        case .error: return "xmark.circle.fill"
        case .info: return "info.circle.fill"
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .foregroundStyle(tint)
            Text(toast.message)
                .foregroundStyle(.primary)
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.footnote.weight(.medium))
        .padding(.horizontal, AppSpacing.lg)
        .padding(.vertical, 14)
        .frame(minHeight: 44)
        .background {
            ZStack {
                Color.hudPanel
                tint.opacity(0.15)
            }
        }
        .clipShape(HudPanelShape(chamfer: 8))
        .overlay(HudPanelShape(chamfer: 8).strokeBorder(tint.opacity(0.9), lineWidth: 1))
        .shadow(color: tint.opacity(0.4), radius: 8)
        .padding(.horizontal, AppSpacing.lg)
        .contentShape(HudPanelShape(chamfer: 8))
        .onTapGesture { onDismiss?() }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
        .onAppear {
            // Delay lets the move transition settle so the announcement isn't clipped.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                AccessibilityNotification.Announcement(toast.message).post()
            }
        }
    }
}
