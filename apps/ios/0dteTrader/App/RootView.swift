import SwiftUI

/// Top-level coordinator:
/// checking session → first-launch risk disclaimer → login/register → trade screen.
/// Also hosts the optional FaceID app-lock overlay (SECURITY.md §5).
struct RootView: View {
    let container: AppContainer

    @StateObject private var authViewModel: AuthViewModel
    @StateObject private var lockManager: AppLockManager
    @Environment(\.scenePhase) private var scenePhase

    init(container: AppContainer) {
        self.container = container
        _authViewModel = StateObject(wrappedValue: container.makeAuthViewModel())
        _lockManager = StateObject(wrappedValue: container.appLockManager)
    }

    var body: some View {
        ZStack {
            Color.appBackground.ignoresSafeArea()
            content
                // Keep the trade screen out of the accessibility tree while locked.
                .accessibilityHidden(lockManager.isLocked)
                .id(authViewModel.state)
                .transition(.opacity)
                .animation(.easeInOut(duration: 0.25), value: authViewModel.state)
            if lockManager.isLocked {
                lockOverlay
                    // Traps VoiceOver focus on the overlay.
                    .accessibilityAddTraits(.isModal)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: lockManager.isLocked)
        .task {
            await authViewModel.start()
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .inactive:
                // Lock before the app-switcher snapshot is taken.
                lockManager.lockIfNeeded()
            case .background:
                lockManager.lockIfNeeded()
            case .active:
                container.quoteSocket.reconnectIfNeeded()
                if lockManager.isLocked {
                    Task { await lockManager.unlock() }
                }
            default:
                break
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch authViewModel.state {
        case .checking:
            VStack(spacing: AppSpacing.xxl) {
                Image(systemName: "chart.line.uptrend.xyaxis")
                    .font(.system(size: 56, weight: .semibold))
                    .foregroundStyle(Color.appAccent)
                    .accessibilityHidden(true)
                ProgressView("Restoring session…")
                    .controlSize(.large)
                    .tint(.appAccent)
                    .foregroundStyle(.secondary)
            }
            .offset(y: -40) // optical centering: block sits ~46% from top, not dead 50%
        case .disclaimer:
            RiskDisclaimerView(viewModel: authViewModel)
        case .unauthenticated:
            LoginView(viewModel: authViewModel)
        case .restoreFailed:
            ErrorStateView(
                message: "Couldn't restore your session. Check your connection and try again.",
                systemImage: "wifi.exclamationmark",
                retryTitle: "Retry",
                onRetry: { authViewModel.retryRestore() }
            )
        case .authenticated:
            TradeScreenView(container: container) {
                await authViewModel.logout()
            }
        }
    }

    private var lockOverlay: some View {
        ZStack {
            Color.appBackground.ignoresSafeArea()
            VStack(spacing: AppSpacing.lg) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                Text("0dteTrader is locked")
                    .font(.headline)
                if lockManager.lastAttemptFailed {
                    Text("Couldn't verify — try again")
                        .font(.subheadline)
                        .foregroundStyle(Color.sellRed)
                }
                Button {
                    Task { await lockManager.unlock() }
                } label: {
                    Label("Unlock with Face ID", systemImage: "faceid")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large) // 50pt tall, above the 44pt HIG minimum
                .tint(.appAccentFill) // white label passes WCAG AA on the fill token
                Button("Sign in with password instead") {
                    Task { await authViewModel.logout() }
                    lockManager.forceUnlock()
                }
                .buttonStyle(.borderless)
            }
        }
        .offset(y: -32) // raises the mass centroid to ≈ 46% of the screen height
        .transition(.opacity)
    }
}
