import LocalAuthentication

/// Optional FaceID gate on app foreground (PRD FR-5, SECURITY.md §5).
/// Enabled from the profile screen; state persisted in SettingsStore.
@MainActor
final class AppLockManager: ObservableObject {
    @Published private(set) var isLocked = false

    private let settingsStore: SettingsStore

    init(settingsStore: SettingsStore) {
        self.settingsStore = settingsStore
    }

    /// Called when the app goes to the background.
    func lockIfNeeded() {
        if settingsStore.appLockEnabled {
            isLocked = true
        }
    }

    /// Prompts FaceID (or falls back to device passcode where permitted) and
    /// unlocks on success. If biometrics are unavailable, unlocks directly —
    /// the gate is a convenience lock, not an auth boundary (the JWT is that).
    func unlock() async {
        let context = LAContext()
        var policyError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
            isLocked = false
            return
        }
        let success = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: "Unlock 0dteTrader"
            ) { result, _ in
                continuation.resume(returning: result)
            }
        }
        isLocked = !success
    }
}
