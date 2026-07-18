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
    @Published var accountId = ""
    @Published var isEditingCredentials = false

    @Published var appLockEnabled: Bool {
        didSet { settingsStore.appLockEnabled = appLockEnabled }
    }

    private let apiClient: APIClient
    private let settingsStore: SettingsStore
    private let onLogout: () async -> Void

    init(apiClient: APIClient, settingsStore: SettingsStore, onLogout: @escaping () async -> Void) {
        self.apiClient = apiClient
        self.settingsStore = settingsStore
        self.onLogout = onLogout
        self.appLockEnabled = settingsStore.appLockEnabled
    }

    /// True when the last `load()` failed. Kept separate from `errorMessage`
    /// so an account-fetch failure doesn't render as a Webull credential error.
    @Published private(set) var loadFailed = false

    var canSaveCredentials: Bool {
        !appKey.trimmingCharacters(in: .whitespaces).isEmpty
            && !appSecret.isEmpty
            && !accountId.trimmingCharacters(in: .whitespaces).isEmpty
    }

    func load() async {
        isLoading = true
        loadFailed = false
        defer { isLoading = false }
        do {
            me = try await apiClient.me()
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
            try await apiClient.putWebullCredentials(
                WebullCredentialsInputDTO(
                    appKey: appKey.trimmingCharacters(in: .whitespaces),
                    appSecret: appSecret,
                    accountId: accountId.trimmingCharacters(in: .whitespaces)
                )
            )
            // Write-only: wipe the fields, never render them back (FR-4).
            appKey = ""
            appSecret = ""
            accountId = ""
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

    func logout() async {
        await onLogout()
    }
}
