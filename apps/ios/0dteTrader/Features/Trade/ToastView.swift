import SwiftUI

struct IVAlertBanner: View {
    let alert: IVAlertDTO
    let onDismiss: () -> Void

    private var direction: String {
        alert.direction == .expansion ? "expansion" : "crush"
    }

    private var detailText: String {
        let metrics = String(
            format: "IV %.1f%% · baseline %.1f%% · z %.2f",
            alert.currentIv * 100,
            alert.baselineIv * 100,
            alert.zScore
        )
        guard let date = DateParsing.dateTime(alert.timestamp) else { return metrics }
        return "\(metrics) · \(date.formatted(date: .omitted, time: .shortened))"
    }

    var accessibilityLabelText: String {
        let time = DateParsing.dateTime(alert.timestamp)?.formatted(date: .omitted, time: .shortened)
            ?? alert.timestamp
        return String(
            format: "%@ implied volatility %@, current %.1f percent, baseline %.1f percent, z score %.2f, at %@",
            alert.symbol.rawValue,
            direction,
            alert.currentIv * 100,
            alert.baselineIv * 100,
            alert.zScore,
            time
        )
    }

    var body: some View {
        HStack(spacing: AppSpacing.sm) {
            Image(systemName: alert.direction == .expansion ? "waveform.path.ecg.rectangle" : "arrow.down.right")
                .foregroundStyle(Color.appWarning)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(alert.symbol.rawValue) IV \(direction)")
                    .font(.subheadline.weight(.semibold))
                Text(detailText)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: AppSpacing.sm)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss IV alert")
        }
        .padding(.horizontal, AppSpacing.md)
        .padding(.vertical, AppSpacing.sm)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.appWarning.opacity(0.55)))
        .padding(.horizontal, AppSpacing.md)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabelText)
    }
}

/// Result banner for order submissions and stream events.
/// Tapping the capsule dismisses it immediately.
struct ToastView: View {
    let toast: Toast
    var onDismiss: (() -> Void)?
    @State private var dragOffset: CGFloat = 0

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
        .offset(y: min(dragOffset, 0))
        .opacity(dragOffset < -40 ? 0 : 1)
        .contentShape(HudPanelShape(chamfer: 8))
        .gesture(
            DragGesture(minimumDistance: 10)
                .onChanged { value in
                    dragOffset = value.translation.height
                }
                .onEnded { value in
                    if value.translation.height < -30 {
                        onDismiss?()
                    } else {
                        withAnimation(.spring(duration: 0.3)) { dragOffset = 0 }
                    }
                }
        )
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
