import Foundation
import LocalAuthentication

/// Backs the profile sheet: account info from GET /v1/me and the write-only
/// Webull credential lifecycle (PUT to save/update, DELETE to remove).
/// Secrets are never re-displayed after saving (PRD FR-4).
@MainActor
final class ProfileViewModel: ObservableObject {
    @Published private(set) var me: MeDTO?
    @Published private(set) var isLoading = false
    @Published private(set) var isSavingCredentials = false
    @Published private(set) var isDeletingCredentials = false
    @Published var errorMessage: String?
    @Published var successMessage: String?

    @Published var appKey = ""
    @Published var appSecret = ""
    @Published var isEditingCredentials = false
    @Published private(set) var isReconnecting = false

    @Published var tradingProvider: BrokerProvider = .webull
    @Published var alpacaApiKey = ""
    @Published var alpacaApiSecret = ""
    @Published var isEditingAlpacaCredentials = false
    @Published private(set) var isSavingAlpacaCredentials = false
    @Published private(set) var isDeletingAlpacaCredentials = false

    @Published var appLockEnabled: Bool {
        didSet { settingsStore.appLockEnabled = appLockEnabled }
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
    }

    /// True when the last `load()` failed. Kept separate from `errorMessage`
    /// so an account-fetch failure doesn't render as a Webull credential error.
    @Published private(set) var loadFailed = false

    var canSaveCredentials: Bool {
        !appKey.trimmingCharacters(in: .whitespaces).isEmpty
            && !appSecret.isEmpty
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

    func saveCredentials() async {
        guard canSaveCredentials, !isSavingCredentials else { return }
        isSavingCredentials = true
        errorMessage = nil
        successMessage = nil
        defer { isSavingCredentials = false }
        do {
            // Account id is intentionally absent: the server discovers it via
            // Webull's account/list once the token is approved.
            try await apiClient.putWebullCredentials(
                WebullCredentialsInputDTO(
                    appKey: appKey.trimmingCharacters(in: .whitespaces),
                    appSecret: appSecret
                )
            )
            // Write-only: wipe the fields, never render them back (FR-4).
            appKey = ""
            appSecret = ""
            isEditingCredentials = false
            successMessage = "Webull credentials saved."
            await load()
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func deleteCredentials() async {
        guard !isDeletingCredentials else { return }
        isDeletingCredentials = true
        errorMessage = nil
        successMessage = nil
        defer { isDeletingCredentials = false }
        do {
            try await apiClient.deleteWebullCredentials()
            successMessage = "Webull credentials removed."
            await load()
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// "Reconnect": mint a fresh Webull access token from the stored
    /// credentials (ProfileStore.reconnect analog) — a stale token never
    /// forces re-entering secrets.
    func reconnect() async {
        guard !isReconnecting else { return }
        isReconnecting = true
        errorMessage = nil
        successMessage = nil
        defer { isReconnecting = false }
        do {
            try await apiClient.refreshWebullSession()
            successMessage = "Webull session refreshed."
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func logout() async {
        await onLogout()
    }

    // MARK: - Alpaca credentials (generic broker-credentials endpoint)

    var canSaveAlpacaCredentials: Bool {
        !alpacaApiKey.trimmingCharacters(in: .whitespaces).isEmpty
            && !alpacaApiSecret.isEmpty
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

    func saveAlpacaCredentials() async {
        guard canSaveAlpacaCredentials, !isSavingAlpacaCredentials else { return }
        isSavingAlpacaCredentials = true
        errorMessage = nil
        successMessage = nil
        defer { isSavingAlpacaCredentials = false }
        do {
            try await apiClient.putAlpacaCredentials(
                AlpacaCredentialsInputDTO(
                    apiKey: alpacaApiKey.trimmingCharacters(in: .whitespaces),
                    apiSecret: alpacaApiSecret
                )
            )
            // Write-only: wipe the fields, never render them back (FR-4).
            alpacaApiKey = ""
            alpacaApiSecret = ""
            isEditingAlpacaCredentials = false
            successMessage = "Alpaca credentials saved."
            await load()
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func deleteAlpacaCredentials() async {
        guard !isDeletingAlpacaCredentials else { return }
        isDeletingAlpacaCredentials = true
        errorMessage = nil
        successMessage = nil
        defer { isDeletingAlpacaCredentials = false }
        do {
            try await apiClient.deleteBrokerCredentials(provider: .alpaca)
            successMessage = "Alpaca credentials removed."
            await load()
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
