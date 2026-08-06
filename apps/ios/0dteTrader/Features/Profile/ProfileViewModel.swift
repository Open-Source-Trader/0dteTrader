import Combine
import Foundation
import LocalAuthentication
// Profile owns the coordinated credential and persisted-preference workflows.
// swiftlint:disable file_length

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

    /// Success/info toast banners on the trade screen. Errors always show.
    @Published var toastsEnabled: Bool {
        didSet { settingsStore.toastsEnabled = toastsEnabled }
    }

    @Published private(set) var autoScoringPreference: AutoScoringPreferenceRecord?
    @Published private(set) var isAutoScoringPreferenceBusy = false
    @Published private(set) var autoScoringPreferenceMessage: String?
    @Published private(set) var ivAlertConfiguration: IVAlertConfigurationStateDTO?
    @Published private(set) var isIVAlertConfigurationBusy = false
    @Published private(set) var ivAlertConfigurationMessage: String?

    /// Push notifications toggle, reflecting the persisted setting. Driven
    /// through `setPushNotificationsEnabled`, not bound directly: enabling
    /// runs the authorization flow and a denial has to revert the switch.
    @Published var pushNotificationsEnabled: Bool

    @Published private(set) var discordSettings: DiscordNotificationSettingsDTO?
    @Published private(set) var legalStatus: LegalAcceptanceStatusDTO?
    @Published private(set) var selectedLegalDocument: LegalDocumentDTO?
    @Published private(set) var isComplianceBusy = false
    @Published private(set) var complianceErrorMessage: String?
    @Published private(set) var complianceSuccessMessage: String?

    private let apiClient: APIClient
    private let settingsStore: SettingsStore
    private let quoteSocket: QuoteSocketClient
    private let pushNotifications: PushNotificationsManager?
    private let ivAlertSaveTimeout: Duration
    private let onLogout: () async -> Void
    private var cancellables: Set<AnyCancellable> = []
    private var ivAlertSaveTimeoutTask: Task<Void, Never>?
    private var pendingIVAlertConfiguration: IVAlertConfigurationDTO?

    init(
        apiClient: APIClient,
        settingsStore: SettingsStore,
        quoteSocket: QuoteSocketClient,
        pushNotifications: PushNotificationsManager? = nil,
        ivAlertSaveTimeout: Duration = .seconds(15),
        onLogout: @escaping () async -> Void
    ) {
        self.apiClient = apiClient
        self.settingsStore = settingsStore
        self.quoteSocket = quoteSocket
        self.pushNotifications = pushNotifications
        self.ivAlertSaveTimeout = ivAlertSaveTimeout
        self.onLogout = onLogout
        self.appLockEnabled = settingsStore.appLockEnabled
        self.bypassOrderConfirmation = settingsStore.bypassOrderConfirmation
        self.toastsEnabled = settingsStore.toastsEnabled
        self.pushNotificationsEnabled = settingsStore.pushNotificationsEnabled
        quoteSocket.$ivAlertConfiguration
            .compactMap { $0 }
            .sink { [weak self] configuration in
                guard let self else { return }
                self.ivAlertConfiguration = configuration
                if let pending = self.pendingIVAlertConfiguration,
                   Self.matches(configuration, pending) {
                    self.finishIVAlertConfigurationSave(message: "IV alert settings saved.")
                }
            }
            .store(in: &cancellables)
        quoteSocket.$lastError
            .compactMap { $0 }
            .filter { $0.code == "IV_ALERT_CONFIGURATION_INVALID" }
            .sink { [weak self] error in
                guard self?.isIVAlertConfigurationBusy == true else { return }
                self?.finishIVAlertConfigurationSave(message: error.message)
            }
            .store(in: &cancellables)
        quoteSocket.$connectionState
            .filter { $0 == .disconnected }
            .sink { [weak self] _ in
                guard self?.isIVAlertConfigurationBusy == true else { return }
                self?.finishIVAlertConfigurationSave(
                    message: "Connection lost before IV alert settings were saved. Try again."
                )
            }
            .store(in: &cancellables)
    }

    /// Profile toggle: drives the manager, then re-reads the setting it
    /// landed on — an authorization denial reverts the switch.
    func setPushNotificationsEnabled(_ enabled: Bool) {
        pushNotificationsEnabled = enabled
        guard let pushNotifications else {
            settingsStore.pushNotificationsEnabled = enabled
            return
        }
        Task {
            await pushNotifications.setEnabled(enabled)
            pushNotificationsEnabled = settingsStore.pushNotificationsEnabled
        }
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

    func loadAutoScoringPreference() async {
        guard !isAutoScoringPreferenceBusy else { return }
        isAutoScoringPreferenceBusy = true
        defer { isAutoScoringPreferenceBusy = false }
        do {
            autoScoringPreference = try await apiClient.autoScoringPreferences()
            autoScoringPreferenceMessage = nil
        } catch let error as APIError {
            autoScoringPreferenceMessage = error.userMessage
        } catch {
            autoScoringPreferenceMessage = error.localizedDescription
        }
    }

    func selectAutoScoringPreset(_ preset: AutoScoringPreset) async {
        guard preset != .custom,
              let current = autoScoringPreference,
              !isAutoScoringPreferenceBusy
        else { return }
        let preferences: AutoScoringPreferences = preset == .aggressive ? .aggressive : .conservative
        isAutoScoringPreferenceBusy = true
        autoScoringPreferenceMessage = nil
        defer { isAutoScoringPreferenceBusy = false }
        do {
            autoScoringPreference = try await apiClient.updateAutoScoringPreferences(
                AutoScoringPreferenceUpdate(
                    preferences: preferences,
                    expectedUpdatedAt: current.updatedAt
                )
            )
            autoScoringPreferenceMessage = "Scored Auto preset saved."
        } catch let error as APIError {
            autoScoringPreferenceMessage = error.userMessage
        } catch {
            autoScoringPreferenceMessage = error.localizedDescription
        }
    }

    func saveCustomAutoScoring(_ preferences: AutoScoringPreferences) async {
        guard let current = autoScoringPreference,
              !isAutoScoringPreferenceBusy,
              preferences.preset == .custom,
              Self.validAutoScoringPreferences(preferences)
        else {
            autoScoringPreferenceMessage = "Enter valid custom settings; at least one weight must be positive."
            return
        }
        isAutoScoringPreferenceBusy = true
        autoScoringPreferenceMessage = nil
        defer { isAutoScoringPreferenceBusy = false }
        do {
            autoScoringPreference = try await apiClient.updateAutoScoringPreferences(
                AutoScoringPreferenceUpdate(
                    preferences: preferences,
                    expectedUpdatedAt: current.updatedAt
                )
            )
            autoScoringPreferenceMessage = "Custom Scored Auto settings saved."
        } catch let error as APIError {
            autoScoringPreferenceMessage = error.userMessage
        } catch {
            autoScoringPreferenceMessage = error.localizedDescription
        }
    }

    func setIVAlertsEnabled(_ enabled: Bool) {
        guard let current = ivAlertConfiguration else { return }
        sendIVAlertConfiguration(IVAlertConfigurationDTO(
            enabled: enabled,
            symbols: current.symbols,
            lookbackMinutes: current.lookbackMinutes,
            thresholdK: current.thresholdK,
            consecutiveBreaches: current.consecutiveBreaches,
            warmupMinutes: current.warmupMinutes,
            warmupSamples: current.warmupSamples,
            cooldownMinutes: current.cooldownMinutes
        ))
    }

    func setIVAlertSymbol(_ symbol: IVAlertSymbolDTO, enabled: Bool) {
        guard let current = ivAlertConfiguration else { return }
        var symbols = current.symbols
        if enabled {
            if !symbols.contains(symbol) { symbols.append(symbol) }
        } else {
            symbols.removeAll { $0 == symbol }
        }
        guard !symbols.isEmpty else {
            ivAlertConfigurationMessage = "Select at least one alert symbol."
            return
        }
        sendIVAlertConfiguration(IVAlertConfigurationDTO(
            enabled: current.enabled,
            symbols: symbols,
            lookbackMinutes: current.lookbackMinutes,
            thresholdK: current.thresholdK,
            consecutiveBreaches: current.consecutiveBreaches,
            warmupMinutes: current.warmupMinutes,
            warmupSamples: current.warmupSamples,
            cooldownMinutes: current.cooldownMinutes
        ))
    }

    func updateIVAlertConfiguration(_ configuration: IVAlertConfigurationDTO) {
        guard Self.validIVAlertConfiguration(configuration) else {
            ivAlertConfigurationMessage = "Enter IV alert settings within the shown limits."
            return
        }
        sendIVAlertConfiguration(configuration)
    }

    private func sendIVAlertConfiguration(_ configuration: IVAlertConfigurationDTO) {
        guard ivAlertConfiguration != nil, !isIVAlertConfigurationBusy else { return }
        guard quoteSocket.connectionState == .connected else {
            ivAlertConfigurationMessage = "Connect to save IV alert settings."
            return
        }
        isIVAlertConfigurationBusy = true
        ivAlertConfigurationMessage = "Saving IV alert settings…"
        pendingIVAlertConfiguration = configuration
        startIVAlertConfigurationSaveTimeout()
        quoteSocket.configureIVAlerts(configuration)
    }

    private func startIVAlertConfigurationSaveTimeout() {
        ivAlertSaveTimeoutTask?.cancel()
        let timeout = ivAlertSaveTimeout
        ivAlertSaveTimeoutTask = Task { [weak self] in
            do {
                try await Task.sleep(for: timeout)
            } catch {
                return
            }
            guard !Task.isCancelled, self?.isIVAlertConfigurationBusy == true else { return }
            self?.finishIVAlertConfigurationSave(
                message: "IV alert settings save timed out. Check your connection and try again."
            )
        }
    }

    private func finishIVAlertConfigurationSave(message: String) {
        ivAlertSaveTimeoutTask?.cancel()
        ivAlertSaveTimeoutTask = nil
        pendingIVAlertConfiguration = nil
        isIVAlertConfigurationBusy = false
        ivAlertConfigurationMessage = message
    }

    private static func matches(
        _ state: IVAlertConfigurationStateDTO,
        _ requested: IVAlertConfigurationDTO
    ) -> Bool {
        state.enabled == requested.enabled
            && Set(state.symbols.map(\.rawValue)) == Set(requested.symbols.map(\.rawValue))
            && state.lookbackMinutes == requested.lookbackMinutes
            && state.thresholdK == requested.thresholdK
            && state.consecutiveBreaches == requested.consecutiveBreaches
            && state.warmupMinutes == requested.warmupMinutes
            && state.warmupSamples == requested.warmupSamples
            && state.cooldownMinutes == requested.cooldownMinutes
    }

    private static func validIVAlertConfiguration(_ value: IVAlertConfigurationDTO) -> Bool {
        (1...3).contains(Set(value.symbols.map(\.rawValue)).count)
            && value.symbols.count == Set(value.symbols.map(\.rawValue)).count
            && (5...240).contains(value.lookbackMinutes)
            && value.thresholdK.isFinite
            && (0.1...20).contains(value.thresholdK)
            && (1...10).contains(value.consecutiveBreaches)
            && (0...60).contains(value.warmupMinutes)
            && (1...240).contains(value.warmupSamples)
            && (0...1_440).contains(value.cooldownMinutes)
    }

    private static func validAutoScoringPreferences(_ value: AutoScoringPreferences) -> Bool {
        let weights = [
            value.weights.delta,
            value.weights.spread,
            value.weights.openInterest,
            value.weights.gamma,
            value.weights.iv,
        ]
        return (0.01...0.99).contains(value.targetAbsDelta)
            && (0...20).contains(value.strikeRungs)
            && (0...10_000).contains(value.maxSpreadBps)
            && value.maxPremiumDollars > 0
            && value.maxPremiumDollars <= 1_000_000
            && (0...1_000_000_000).contains(value.minOpenInterest)
            && weights.allSatisfy { $0.isFinite && (0...1).contains($0) }
            && weights.reduce(0, +) > 0
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
        // Push teardown lives in RootView's signOut(), which every sign-out
        // route — this one included — funnels through.
        await onLogout()
    }

    func loadCompliance() async {
        guard !isComplianceBusy else { return }
        isComplianceBusy = true
        defer { isComplianceBusy = false }
        clearComplianceMessages()
        var failures: [String] = []
        do {
            discordSettings = try await apiClient.discordSettings()
        } catch {
            failures.append("Discord: \(userMessage(for: error))")
        }
        do {
            legalStatus = try await apiClient.legalStatus()
        } catch {
            failures.append("Legal: \(userMessage(for: error))")
        }
        if !failures.isEmpty {
            complianceErrorMessage = failures.joined(separator: " ")
        }
    }

    func saveDiscord(webhookUrl: String, enabled: Bool, includePnl: Bool) async {
        guard !isComplianceBusy else { return }
        isComplianceBusy = true
        defer { isComplianceBusy = false }
        clearComplianceMessages()
        do {
            discordSettings = try await apiClient.updateDiscordSettings(
                DiscordNotificationSettingsUpdateDTO(
                    webhookUrl: webhookUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? nil
                        : webhookUrl.trimmingCharacters(in: .whitespacesAndNewlines),
                    enabled: enabled,
                    includePnl: includePnl
                )
            )
            complianceSuccessMessage = "Discord settings saved."
        } catch {
            setComplianceError(error)
        }
    }

    func testDiscord() async {
        guard !isComplianceBusy else { return }
        isComplianceBusy = true
        defer { isComplianceBusy = false }
        clearComplianceMessages()
        do {
            try await apiClient.testDiscord()
            complianceSuccessMessage = "Test notification sent."
        } catch {
            setComplianceError(error)
        }
    }

    func showLegalDocument(_ slug: LegalDocumentSlug) async {
        guard !isComplianceBusy else { return }
        isComplianceBusy = true
        defer { isComplianceBusy = false }
        clearComplianceMessages()
        selectedLegalDocument = nil
        do {
            selectedLegalDocument = try await apiClient.legalDocument(slug)
        } catch {
            setComplianceError(error)
        }
    }

    func closeLegalDocument() {
        selectedLegalDocument = nil
    }

    func acceptLegal(_ document: LegalDocumentDTO) async {
        guard !isComplianceBusy,
              document.slug == .terms || document.slug == .risk else { return }
        isComplianceBusy = true
        defer { isComplianceBusy = false }
        clearComplianceMessages()
        do {
            legalStatus = try await apiClient.acceptLegal(
                document: document.slug,
                version: document.version
            )
            complianceSuccessMessage = "\(document.title) accepted."
        } catch {
            setComplianceError(error)
        }
    }

    func deleteAccount(confirmEmail: String) async {
        guard !isComplianceBusy else { return }
        isComplianceBusy = true
        defer { isComplianceBusy = false }
        clearComplianceMessages()
        do {
            try await apiClient.deleteAccount(confirmEmail: confirmEmail)
            await onLogout()
        } catch {
            setComplianceError(error)
        }
    }

    private func clearComplianceMessages() {
        complianceErrorMessage = nil
        complianceSuccessMessage = nil
    }

    private func setComplianceError(_ error: Error) {
        complianceErrorMessage = userMessage(for: error)
    }

    private func userMessage(for error: Error) -> String {
        if let apiError = error as? APIError {
            return apiError.userMessage
        }
        return error.localizedDescription
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
