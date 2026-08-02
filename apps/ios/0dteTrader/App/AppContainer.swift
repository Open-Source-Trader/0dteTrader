import Foundation

/// Dependency container. Owns the singletons (networking, storage) and
/// vends feature view models. Built from the active API base URL; the app
/// rebuilds it when the user switches servers (#59).
@MainActor
final class AppContainer: ObservableObject {
    let baseURL: URL
    let settingsStore: SettingsStore
    let keychainStore: KeychainStore
    let sessionStore: SessionStore
    let apiClient: APIClient
    let quoteSocket: QuoteSocketClient
    let appLockManager: AppLockManager
    private let urlSession: URLSession

    init(baseURL: URL) {
        let settings = SettingsStore()
        // Scoped per server origin so a refresh token issued by one server is
        // never sent to another after a runtime server change.
        KeychainStore.removeLegacyRefreshToken()
        let keychain = KeychainStore(account: KeychainStore.refreshTokenAccount(for: baseURL))
        // Pins apply only when this is the built-in default host.
        let pinningDelegate = CertificatePinningDelegate(pinnedHashes: AppConfig.pinnedPublicKeyHashes(for: baseURL))
        let urlSession = URLSession(configuration: .default, delegate: pinningDelegate, delegateQueue: nil)
        let sessionStore = SessionStore(keychainStore: keychain, baseURL: baseURL, urlSession: urlSession)

        self.urlSession = urlSession
        self.baseURL = baseURL
        self.settingsStore = settings
        self.keychainStore = keychain
        self.sessionStore = sessionStore
        self.apiClient = APIClient(baseURL: baseURL, sessionStore: sessionStore, urlSession: urlSession)
        self.quoteSocket = QuoteSocketClient(streamURL: ServerConfigStore.streamURL(for: baseURL), urlSession: urlSession) {
            try await sessionStore.accessTokenOrRefresh()
        }
        self.appLockManager = AppLockManager(settingsStore: settings)
    }

    deinit {
        // URLSession retains its delegate until invalidated; without this,
        // every server switch would leak the replaced container's session,
        // pinning delegate, and connection pool.
        urlSession.finishTasksAndInvalidate()
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
        let settings = settingsStore
        return OptionsChainViewModel(apiClient: apiClient, autoOtmOffset: { settings.autoOtmOffset })
    }

    func makeTradeViewModel() -> TradeViewModel {
        TradeViewModel(apiClient: apiClient)
    }

    func makeChartOrdersModel() -> ChartOrdersModel {
        ChartOrdersModel(apiClient: apiClient)
    }

    func makeChartTradingCoordinator(chartOrders: ChartOrdersModel) -> ChartTradingCoordinator {
        ChartTradingCoordinator(chartOrders: chartOrders, settingsStore: settingsStore)
    }

    func makeProfileViewModel(onLogout: @escaping () async -> Void) -> ProfileViewModel {
        ProfileViewModel(
            apiClient: apiClient,
            settingsStore: settingsStore,
            quoteSocket: quoteSocket,
            onLogout: onLogout
        )
    }
}
