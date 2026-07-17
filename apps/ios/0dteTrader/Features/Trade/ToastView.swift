import SwiftUI

/// Result banner for order submissions and stream events.
struct ToastView: View {
    let toast: Toast

    private var tint: Color {
        switch toast.style {
        case .success: return Color.pnlPositive
        case .error: return Color.pnlNegative
        case .info: return Color.appAccent
        }
    }

    private var icon: String {
        switch toast.style {
        case .success: return "checkmark.circle.fill"
        case .error: return "exclamationmark.triangle.fill"
        case .info: return "info.circle.fill"
        }
    }

    var body: some View {
        Label(toast.message, systemImage: icon)
            .font(.footnote.weight(.medium))
            .foregroundStyle(.primary)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color.appSurfaceElevated)
            .clipShape(Capsule())
            .overlay(Capsule().stroke(tint.opacity(0.6), lineWidth: 1))
            .shadow(radius: 6)
            .padding(.horizontal, 16)
    }
}
