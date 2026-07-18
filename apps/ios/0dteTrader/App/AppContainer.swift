import Foundation

/// Dependency container. Owns the singletons (networking, storage) and
/// vends feature view models. Created once at app launch.
@MainActor
final class AppContainer: ObservableObject {
    let settingsStore: SettingsStore
    let keychainStore: KeychainStore
    let sessionStore: SessionStore
    let apiClient: APIClient
    let quoteSocket: QuoteSocketClient
    let appLockManager: AppLockManager

    init() {
        let settings = SettingsStore()
        let keychain = KeychainStore()
        let pinningDelegate = CertificatePinningDelegate(pinnedHashes: AppConfig.pinnedPublicKeyHashes)
        let urlSession = URLSession(configuration: .default, delegate: pinningDelegate, delegateQueue: nil)
        let sessionStore = SessionStore(keychainStore: keychain, baseURL: AppConfig.apiBaseURL, urlSession: urlSession)

        self.settingsStore = settings
        self.keychainStore = keychain
        self.sessionStore = sessionStore
        self.apiClient = APIClient(baseURL: AppConfig.apiBaseURL, sessionStore: sessionStore, urlSession: urlSession)
        self.quoteSocket = QuoteSocketClient(streamURL: AppConfig.streamURL, urlSession: urlSession) {
            try await sessionStore.accessTokenOrRefresh()
        }
        self.appLockManager = AppLockManager(settingsStore: settings)
    }

    // MARK: - View model factories

    func makeAuthViewModel() -> AuthViewModel {
        AuthViewModel(
            apiClient: apiClient,
            sessionStore: sessionStore,
            settingsStore: settingsStore,
            socket: quoteSocket
        )
    }

    func makeChartViewModel() -> ChartViewModel {
        ChartViewModel(apiClient: apiClient, socket: quoteSocket, settingsStore: settingsStore)
    }

    func makeOptionsChainViewModel() -> OptionsChainViewModel {
        OptionsChainViewModel(apiClient: apiClient)
    }

    func makeTradeViewModel() -> TradeViewModel {
        TradeViewModel(apiClient: apiClient)
    }

    func makeProfileViewModel(onLogout: @escaping () async -> Void) -> ProfileViewModel {
        ProfileViewModel(apiClient: apiClient, settingsStore: settingsStore, onLogout: onLogout)
    }
}
