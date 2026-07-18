import SwiftUI
import UIKit

/// Placeholder block shown while content loads. Pulses subtly; the pulse is
/// disabled when Reduce Motion is on. Size it with `.frame(...)` at the
/// call site.
struct SkeletonView: View {
    var cornerRadius: CGFloat = AppRadius.sm

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isPulsing = false

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(Color.appSurfaceElevated)
            .opacity(isPulsing ? 0.45 : 1)
            .animation(
                reduceMotion ? nil : Animation.easeInOut(duration: 0.9).repeatForever(autoreverses: true),
                value: isPulsing
            )
            .onAppear {
                if !reduceMotion { isPulsing = true }
            }
            .accessibilityHidden(true)
    }
}

/// Full-area error state: icon, message and an optional retry button.
/// The message is announced to VoiceOver when the view appears.
struct ErrorStateView: View {
    let message: String
    var systemImage: String = "exclamationmark.triangle.fill"
    var retryTitle: String = "Retry"
    var onRetry: (() -> Void)?

    var body: some View {
        VStack(spacing: AppSpacing.md) {
            Image(systemName: systemImage)
                .font(.largeTitle)
                .foregroundStyle(Color.pnlNegative)
                .accessibilityHidden(true)

            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            if let onRetry {
                Button {
                    Haptics.impact(.light)
                    onRetry()
                } label: {
                    Text(retryTitle)
                        .font(.chipLabel)
                        .foregroundStyle(.white)
                        .padding(.horizontal, AppSpacing.lg)
                        .frame(minHeight: 44)
                        .background(Color.appAccentFill)
                        .clipShape(Capsule())
                        .contentShape(Capsule())
                }
                .buttonStyle(AppPressStyle())
            }
        }
        .padding(AppSpacing.lg)
        .frame(maxWidth: .infinity)
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                UIAccessibility.post(notification: .announcement, argument: message)
            }
        }
    }
}
