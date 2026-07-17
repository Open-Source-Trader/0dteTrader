import Foundation

/// Drives the auth flow: first-launch disclaimer gate, session restore from the
/// Keychain-stored refresh token, login/register, logout, and forced logout when
/// the refresh token is rejected (`sessionDidBecomeUnauthenticated`).
@MainActor
final class AuthViewModel: ObservableObject {
    enum State: Equatable {
        case checking
        case disclaimer
        case unauthenticated
        case authenticated
    }

    @Published private(set) var state: State = .checking
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    private let apiClient: APIClient
    private let sessionStore: SessionStore
    private let settingsStore: SettingsStore
    private let socket: QuoteSocketClient
    private var sessionObserver: NSObjectProtocol?

    init(apiClient: APIClient, sessionStore: SessionStore, settingsStore: SettingsStore, socket: QuoteSocketClient) {
        self.apiClient = apiClient
        self.sessionStore = sessionStore
        self.settingsStore = settingsStore
        self.socket = socket
        sessionObserver = NotificationCenter.default.addObserver(
            forName: .sessionDidBecomeUnauthenticated,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.handleSessionExpired()
            }
        }
    }

    deinit {
        if let sessionObserver {
            NotificationCenter.default.removeObserver(sessionObserver)
        }
    }

    /// Entry point on app launch.
    func start() async {
        guard settingsStore.hasAcceptedRiskDisclaimer else {
            state = .disclaimer
            return
        }
        await restoreSession()
    }

    func acceptDisclaimer() {
        settingsStore.hasAcceptedRiskDisclaimer = true
        state = .checking
        Task { await restoreSession() }
    }

    func login(email: String, password: String) async {
        await authenticate { [apiClient] in
            try await apiClient.login(email: email, password: password)
        }
    }

    func register(email: String, password: String) async {
        await authenticate { [apiClient] in
            try await apiClient.register(email: email, password: password)
        }
    }

    func logout() async {
        socket.disconnect()
        await sessionStore.signOut()
        state = .unauthenticated
    }

    // MARK: - Internals

    private func restoreSession() async {
        state = .checking
        if await sessionStore.restoreSession() {
            becomeAuthenticated()
        } else {
            state = .unauthenticated
        }
    }

    private func authenticate(_ action: () async throws -> AuthTokensDTO) async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let tokens = try await action()
            try await sessionStore.signIn(with: tokens)
            becomeAuthenticated()
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func becomeAuthenticated() {
        socket.connect()
        state = .authenticated
    }

    private func handleSessionExpired() {
        socket.disconnect()
        errorMessage = APIError.unauthorized.userMessage
        state = .unauthenticated
    }
}
