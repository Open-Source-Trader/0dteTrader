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
            if lockManager.isLocked {
                lockOverlay
            }
        }
        .task {
            await authViewModel.start()
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
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
            ProgressView("Restoring session…")
        case .disclaimer:
            RiskDisclaimerView(viewModel: authViewModel)
        case .unauthenticated:
            LoginView(viewModel: authViewModel)
        case .authenticated:
            TradeScreenView(container: container) {
                await authViewModel.logout()
            }
        }
    }

    private var lockOverlay: some View {
        ZStack {
            Color.appBackground.ignoresSafeArea()
            VStack(spacing: 16) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(.secondary)
                Text("0dteTrader is locked")
                    .font(.headline)
                Button("Unlock") {
                    Task { await lockManager.unlock() }
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .transition(.opacity)
    }
}
