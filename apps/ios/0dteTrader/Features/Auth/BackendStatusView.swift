import SwiftUI

/// Login-footer backend indicator: a status light + label, with the server
/// picker's Change affordance beneath. Probes `/v1/health` on appear and
/// whenever the active server changes; tapping the light re-checks.
/// Mirrors `apps/desktop/src/features/auth/BackendStatus.tsx`.
struct BackendStatusView: View {
    let baseURL: URL
    let onChange: () -> Void

    private enum Status {
        case checking, connected, unreachable

        var label: String {
            switch self {
            case .checking: return "Checking Backend…"
            case .connected: return "Backend Connected"
            case .unreachable: return "Backend Unreachable"
            }
        }

        var color: Color {
            switch self {
            case .checking: return .appWarning
            case .connected: return .pnlPositive
            case .unreachable: return .pnlNegative
            }
        }
    }

    @State private var status: Status = .checking
    @State private var attempt = 0

    var body: some View {
        VStack(spacing: AppSpacing.xs) {
            Button {
                attempt += 1
            } label: {
                HStack(spacing: AppSpacing.sm) {
                    Circle()
                        .fill(status.color)
                        .frame(width: 8, height: 8)
                        .shadow(color: status.color, radius: 3)
                        .accessibilityHidden(true)
                    Text(status.label)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .frame(minHeight: 24)
                .padding(.horizontal, AppSpacing.md)
                .contentShape(Rectangle())
            }
            .buttonStyle(AppPressStyle())
            .animation(AppMotion.standard, value: status.label)
            .accessibilityLabel("\(status.label). Server \(ServerSelect.hostLabel(baseURL))")
            .accessibilityHint("Checks the connection again")

            Button("Change", action: onChange)
                .font(.footnote)
                .foregroundStyle(Color.appAccent)
                .frame(minHeight: 28)
                .padding(.horizontal, AppSpacing.md)
                .contentShape(Rectangle())
                .accessibilityHint("Opens the server picker")
        }
        .task(id: "\(baseURL.absoluteString)#\(attempt)") {
            status = .checking
            let result = await ServerConfigStore.checkHealth(of: baseURL.absoluteString)
            if !Task.isCancelled {
                status = result.ok ? .connected : .unreachable
            }
        }
    }
}
