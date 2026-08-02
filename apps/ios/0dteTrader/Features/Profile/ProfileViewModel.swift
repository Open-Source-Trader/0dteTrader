import Foundation
import LocalAuthentication

/// Backs the profile sheet: account info from GET /v1/me and the write-only
/// Webull credential lifecycle (PUT to save/update, DELETE to remove).
/// Secrets are never re-displayed after saving (PRD FR-4).
@MainActor
final class ProfileViewModel: ObservableObject {
    @Published private(set) var me: MeDTO?
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?
    @Published var successMessage: String?

    @Published var tradingProvider: BrokerProvider = .webull

    // Per-environment (live / practice) credential lifecycle state.
    @Published private(set) var savingWebull: Set<TradingMode> = []
    @Published private(set) var deletingWebull: Set<TradingMode> = []
    @Published private(set) var reconnectingWebull: Set<TradingMode> = []
    @Published private(set) var editingWebull: Set<TradingMode> = []
    @Published private(set) var webullAccounts: [TradingMode: [WebullAccountDTO]] = [.live: [], .practice: []]
    @Published private(set) var loadingWebullAccounts: Set<TradingMode> = []
    @Published private(set) var selectingWebullAccount: Set<TradingMode> = []

    @Published private(set) var savingAlpaca: Set<TradingMode> = []
    @Published private(set) var deletingAlpaca: Set<TradingMode> = []
    @Published private(set) var editingAlpaca: Set<TradingMode> = []

    @Published private(set) var savingTradier: Set<TradingMode> = []
    @Published private(set) var deletingTradier: Set<TradingMode> = []
    @Published private(set) var editingTradier: Set<TradingMode> = []

    // SnapTrade Personal client ID / consumer key — user-entered, write-only,
    // same lifecycle shape as Alpaca. Never server-minted.
    @Published private(set) var savingSnapTradeKey: Set<TradingMode> = []
    @Published private(set) var deletingSnapTradeKey: Set<TradingMode> = []
    @Published private(set) var editingSnapTradeKey: Set<TradingMode> = []

    @Published private(set) var connectingSnaptrade: Set<TradingMode> = []
    @Published private(set) var disconnectingSnaptrade: Set<TradingMode> = []
    @Published private(set) var reconnectingSnaptrade: Set<TradingMode> = []
    @Published private(set) var snapTradeConnections: [TradingMode: [SnapTradeConnectionRecordDTO]] = [
        .live: [],
        .practice: []
    ]
    @Published private(set) var snapTradeAccounts: [TradingMode: [String: [SnapTradeAccountDTO]]] = [
        .live: [:],
        .practice: [:]
    ]
    @Published private(set) var snapTradeStatus: [TradingMode: SnapTradeConnectionStatusDTO] = [
        .live: .init(configured: false, selectedAccountId: nil),
        .practice: .init(configured: false, selectedAccountId: nil)
    ]
    @Published var snapTradeRedirectURL: URL?
    @Published var snapTradePendingRefreshEnvironment: TradingMode?

    /// Which section the current success/error message belongs to.
    @Published private(set) var messageEnv: TradingMode? = nil
    /// Provider the current message belongs to — the Tradier sections render
    /// alongside the Webull ones, so the environment alone no longer
    /// identifies a section.
    @Published private(set) var messageProvider: BrokerProvider? = nil

    @Published var appLockEnabled: Bool {
        didSet { settingsStore.appLockEnabled = appLockEnabled }
    }

    @Published var bypassOrderConfirmation: Bool {
        didSet { settingsStore.bypassOrderConfirmation = bypassOrderConfirmation }
    }

    /// AUTO mode's strikes-OTM preference (0 = ATM). The stepper caps at 5;
    /// the store clamps 0...10 on read for stale values.
    @Published var autoOtmOffset: Int {
        didSet { settingsStore.autoOtmOffset = autoOtmOffset }
    }

    private let apiClient: APIClient
    private let settingsStore: SettingsStore
    private let quoteSocket: QuoteSocketClient
    private let onLogout: () async -> Void

    init(
        apiClient: APIClient,
        settingsStore: SettingsStore,
        quoteSocket: QuoteSocketClient,
        onLogout: @escaping () async -> Void
    ) {
        self.apiClient = apiClient
        self.settingsStore = settingsStore
        self.quoteSocket = quoteSocket
        self.onLogout = onLogout
        self.appLockEnabled = settingsStore.appLockEnabled
        self.bypassOrderConfirmation = settingsStore.bypassOrderConfirmation
        self.autoOtmOffset = settingsStore.autoOtmOffset
    }

    /// True when the last `load()` failed. Kept separate from `errorMessage`
    /// so an account-fetch failure doesn't render as a Webull credential error.
    @Published private(set) var loadFailed = false

    // MARK: - Credential editing (per environment)

    func setEditingWebull(_ environment: TradingMode, _ isEditing: Bool) {
        if isEditing { editingWebull.insert(environment) } else { editingWebull.remove(environment) }
    }

    func setEditingAlpaca(_ environment: TradingMode, _ isEditing: Bool) {
        if isEditing { editingAlpaca.insert(environment) } else { editingAlpaca.remove(environment) }
    }

    func setEditingTradier(_ environment: TradingMode, _ isEditing: Bool) {
        if isEditing { editingTradier.insert(environment) } else { editingTradier.remove(environment) }
    }

    func setEditingSnapTradeKey(_ environment: TradingMode, _ isEditing: Bool) {
        if isEditing {
            editingSnapTradeKey.insert(environment)
        } else {
            editingSnapTradeKey.remove(environment)
        }
    }

    func load() async {
        isLoading = true
        loadFailed = false
        defer { isLoading = false }
        do {
            me = try await apiClient.me()
            tradingProvider = me?.tradingProvider ?? .webull
        } catch {
            // Surfaced in the Account section with a retry affordance, not as
            // a Webull credential error.
            loadFailed = true
        }
    }

    /// Persists the Face ID gate, but only when biometrics are actually
    /// available; otherwise reverts and surfaces an error.
    func setAppLockEnabled(_ enabled: Bool) {
        if enabled {
            var policyError: NSError?
            guard LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &policyError) else {
                appLockEnabled = false
                errorMessage = "Face ID isn't set up on this device."
                return
            }
        }
        appLockEnabled = enabled
    }

    func saveWebull(environment: TradingMode, appKey: String, appSecret: String) async {
        guard !savingWebull.contains(environment),
              !appKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !appSecret.isEmpty else { return }
        savingWebull.insert(environment)
        errorMessage = nil
        successMessage = nil
        messageEnv = environment
        messageProvider = .webull
        defer { savingWebull.remove(environment) }
        do {
            // Account id is intentionally absent: the server discovers it via
            // Webull's account/list once the token is approved.
            try await apiClient.putWebullCredentials(
                WebullCredentialsInputDTO(
                    appKey: appKey.trimmingCharacters(in: .whitespacesAndNewlines),
                    appSecret: appSecret,
                    environment: environment
                )
            )
            editingWebull.remove(environment)
            successMessage = "Webull \(environment.label) credentials saved."
            await load()
        } catch {
            setError(error)
        }
    }

    func deleteWebull(environment: TradingMode) async {
        guard !deletingWebull.contains(environment) else { return }
        deletingWebull.insert(environment)
        errorMessage = nil
        successMessage = nil
        messageEnv = environment
        messageProvider = .webull
        defer { deletingWebull.remove(environment) }
        do {
            try await apiClient.deleteWebullCredentials(environment: environment)
            successMessage = "Webull \(environment.label) credentials removed."
            await load()
        } catch {
            setError(error)
        }
    }

    /// "Reconnect": mint a fresh Webull access token from the stored
    /// credentials (ProfileStore.reconnect analog) — a stale token never
    /// forces re-entering secrets.
    func reconnect(environment: TradingMode) async {
        guard !reconnectingWebull.contains(environment) else { return }
        reconnectingWebull.insert(environment)
        errorMessage = nil
        successMessage = nil
        messageEnv = environment
        messageProvider = .webull
        defer { reconnectingWebull.remove(environment) }
        do {
            try await apiClient.refreshWebullSession()
            successMessage = "Webull session refreshed."
        } catch {
            setError(error)
        }
    }

    func loadWebullAccounts(environment: TradingMode) async {
        guard !loadingWebullAccounts.contains(environment) else { return }
        loadingWebullAccounts.insert(environment)
        defer { loadingWebullAccounts.remove(environment) }
        do {
            webullAccounts[environment] = try await apiClient.webullAccounts(environment: environment)
        } catch {
            messageEnv = environment
            messageProvider = .webull
            setError(error)
        }
    }

    func selectWebullAccount(environment: TradingMode, accountId: String) async {
        guard !selectingWebullAccount.contains(environment) else { return }
        selectingWebullAccount.insert(environment)
        defer { selectingWebullAccount.remove(environment) }
        do {
            try await apiClient.selectWebullAccount(accountId: accountId, environment: environment)
            successMessage = "Webull account selected."
            messageEnv = environment
            messageProvider = .webull
            await load()
        } catch {
            messageEnv = environment
            messageProvider = .webull
            setError(error)
        }
    }

    func logout() async {
        await onLogout()
    }

    // MARK: - Alpaca credentials (generic broker-credentials endpoint)

    func saveAlpaca(environment: TradingMode, apiKey: String, apiSecret: String) async {
        guard !savingAlpaca.contains(environment),
              !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !apiSecret.isEmpty else { return }
        savingAlpaca.insert(environment)
        errorMessage = nil
        successMessage = nil
        messageEnv = environment
        messageProvider = .alpaca
        defer { savingAlpaca.remove(environment) }
        do {
            try await apiClient.putAlpacaCredentials(
                AlpacaCredentialsInputDTO(
                    apiKey: apiKey.trimmingCharacters(in: .whitespacesAndNewlines),
                    apiSecret: apiSecret,
                    environment: environment
                )
            )
            editingAlpaca.remove(environment)
            successMessage = "Alpaca \(environment.label) credentials saved."
            await load()
        } catch {
            setError(error)
        }
    }

    func setTradingProvider(_ provider: BrokerProvider) async {
        errorMessage = nil
        successMessage = nil
        do {
            let updated = try await apiClient.updateTradingProvider(provider)
            tradingProvider = updated.tradingProvider ?? provider
            await load()
            // Re-establish the market-data stream so live quotes use the newly
            // selected provider immediately.
            quoteSocket.reconnect()
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func deleteAlpaca(environment: TradingMode) async {
        guard !deletingAlpaca.contains(environment) else { return }
        deletingAlpaca.insert(environment)
        errorMessage = nil
        successMessage = nil
        messageEnv = environment
        messageProvider = .alpaca
        defer { deletingAlpaca.remove(environment) }
        do {
            try await apiClient.deleteBrokerCredentials(provider: .alpaca, environment: environment)
            successMessage = "Alpaca \(environment.label) credentials removed."
            await load()
        } catch {
            setError(error)
        }
    }

    // MARK: - Tradier market-data API key (generic broker-credentials endpoint)

    func saveTradier(environment: TradingMode, apiKey: String) async {
        guard !savingTradier.contains(environment),
              !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        savingTradier.insert(environment)
        errorMessage = nil
        successMessage = nil
        messageEnv = environment
        messageProvider = .tradier
        defer { savingTradier.remove(environment) }
        do {
            try await apiClient.putTradierCredentials(
                TradierCredentialsInputDTO(
                    apiKey: apiKey.trimmingCharacters(in: .whitespacesAndNewlines),
                    environment: environment
                )
            )
            editingTradier.remove(environment)
            successMessage = "Tradier \(environment.label) API key saved."
            await load()
        } catch {
            setError(error)
        }
    }

    func deleteTradier(environment: TradingMode) async {
        guard !deletingTradier.contains(environment) else { return }
        deletingTradier.insert(environment)
        errorMessage = nil
        successMessage = nil
        messageEnv = environment
        messageProvider = .tradier
        defer { deletingTradier.remove(environment) }
        do {
            try await apiClient.deleteBrokerCredentials(provider: .tradier, environment: environment)
            successMessage = "Tradier \(environment.label) API key removed."
            await load()
        } catch {
            setError(error)
        }
    }

    // MARK: - SnapTrade Personal client ID / consumer key (generic broker-credentials endpoint)

    func saveSnapTradeKey(environment: TradingMode, clientId: String, consumerKey: String) async {
        guard !savingSnapTradeKey.contains(environment),
              !clientId.trimmingCharacters(in: .whitespaces).isEmpty,
              !consumerKey.isEmpty else { return }
        savingSnapTradeKey.insert(environment)
        errorMessage = nil
        successMessage = nil
        messageEnv = environment
        messageProvider = .snaptrade
        defer { savingSnapTradeKey.remove(environment) }
        do {
            try await apiClient.putSnapTradeCredentials(
                SnapTradeCredentialsInputDTO(
                    clientId: clientId.trimmingCharacters(in: .whitespaces),
                    consumerKey: consumerKey,
                    environment: environment
                )
            )
            editingSnapTradeKey.remove(environment)
            successMessage = "SnapTrade \(environment.label) credentials saved."
            await load()
        } catch {
            setError(error)
        }
    }

    func deleteSnapTradeKey(environment: TradingMode) async {
        guard !deletingSnapTradeKey.contains(environment) else { return }
        deletingSnapTradeKey.insert(environment)
        errorMessage = nil
        successMessage = nil
        messageEnv = environment
        messageProvider = .snaptrade
        defer { deletingSnapTradeKey.remove(environment) }
        do {
            try await apiClient.deleteBrokerCredentials(provider: .snaptrade, environment: environment)
            successMessage = "SnapTrade \(environment.label) credentials removed."
            await load()
        } catch {
            setError(error)
        }
    }

    // MARK: - SnapTrade connection lifecycle

    func loadSnapTradeConnections() async {
        if me?.snaptradeKeyConfigured == true {
            await loadSnapTradeConnections(environment: .live)
        } else {
            clearSnapTradeConnections(environment: .live)
        }

        if me?.snaptradeKeyPracticeConfigured == true {
            await loadSnapTradeConnections(environment: .practice)
        } else {
            clearSnapTradeConnections(environment: .practice)
        }
    }

    private func clearSnapTradeConnections(environment: TradingMode) {
        snapTradeConnections[environment] = []
        snapTradeAccounts[environment] = [:]
        snapTradeStatus[environment] = .init(configured: false, selectedAccountId: nil)
    }

    func loadSnapTradeConnections(environment: TradingMode) async {
        let key = environment
        connectingSnaptrade.remove(key)
        reconnectingSnaptrade.remove(key)
        errorMessage = nil
        do {
            let response = try await apiClient.getSnapTradeConnections(environment: environment)
            snapTradeConnections[key] = response.connections
            snapTradeAccounts[key] = response.accounts
            snapTradeStatus[key] = response.status
        } catch {
            setError(error)
        }
    }

    func connectSnapTrade(environment: TradingMode) async {
        let key = environment
        guard !connectingSnaptrade.contains(key) else { return }
        connectingSnaptrade.insert(key)
        errorMessage = nil
        successMessage = nil
        messageEnv = key
        defer { connectingSnaptrade.remove(key) }
        do {
            let response = try await apiClient.authorizeSnapTrade(environment: environment, connectionType: "trade")
            snapTradeRedirectURL = URL(string: response.redirectUrl)
            snapTradePendingRefreshEnvironment = key
            successMessage = "SnapTrade brokerage connected."
        } catch {
            setError(error)
        }
    }

    func reconnectSnapTrade(environment: TradingMode, connectionId: String) async {
        let key = environment
        guard !reconnectingSnaptrade.contains(key) else { return }
        reconnectingSnaptrade.insert(key)
        errorMessage = nil
        successMessage = nil
        messageEnv = key
        defer { reconnectingSnaptrade.remove(key) }
        do {
            let response = try await apiClient.reconnectSnapTrade(environment: environment, connectionId: connectionId)
            snapTradeRedirectURL = URL(string: response.redirectUrl)
            snapTradePendingRefreshEnvironment = key
            successMessage = "SnapTrade connection refreshed."
        } catch {
            setError(error)
        }
    }

    func selectSnapTradeAccount(
        environment: TradingMode,
        connectionId: String,
        accountId: String
    ) async {
        do {
            _ = try await apiClient.selectSnapTradeAccount(
                environment: environment,
                connectionId: connectionId,
                accountId: accountId
            )
            await loadSnapTradeConnections(environment: environment)
            successMessage = "SnapTrade trading account selected."
        } catch {
            setError(error)
        }
    }

    func disconnectSnapTrade(environment: TradingMode, connectionId: String) async {
        let key = environment
        guard !disconnectingSnaptrade.contains(key) else { return }
        disconnectingSnaptrade.insert(key)
        errorMessage = nil
        successMessage = nil
        messageEnv = key
        defer { disconnectingSnaptrade.remove(key) }
        do {
            try await apiClient.deleteSnapTradeConnection(environment: key, connectionId: connectionId)
            await loadSnapTradeConnections(environment: key)
            successMessage = "SnapTrade connection removed."
        } catch {
            setError(error)
        }
    }

    private func setError(_ error: Error) {
        if let apiError = error as? APIError {
            errorMessage = apiError.userMessage
        } else {
            errorMessage = error.localizedDescription
        }
    }
}
