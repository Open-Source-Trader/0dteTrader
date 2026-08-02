import UIKit
import UserNotifications

/// APNs device-token encoding, kept pure so it is testable without UIKit.
enum PushTokenEncoding {
    /// Lowercase hex, two digits per byte — the format the backend stores.
    static func hexString(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }
}

/// What the manager should do next. Pure values so the toggle's transitions
/// are unit-testable without UIKit or UNUserNotificationCenter.
enum PushRegistrationAction: Equatable {
    /// Ask the user for notification permission (a no-op prompt when it was
    /// already granted or denied — iOS answers from the recorded choice).
    case requestAuthorization
    /// Permission granted: ask iOS for a device token.
    case registerWithAPNs
    /// Tear down: DELETE the uploaded token (when there is one), then stop
    /// APNs delivery.
    case unregister(uploadedToken: String?)
    /// Authorization denied: the toggle cannot stay on.
    case revertToggle
}

enum PushRegistrationFlow {
    static func onToggle(enabled: Bool, uploadedToken: String?) -> PushRegistrationAction {
        enabled ? .requestAuthorization : .unregister(uploadedToken: uploadedToken)
    }

    static func onAuthorization(granted: Bool) -> PushRegistrationAction {
        granted ? .registerWithAPNs : .revertToggle
    }
}

/// Owns the push-notification lifecycle: authorization, APNs registration,
/// uploading the device token, and tearing it all down when the Profile
/// toggle turns off. `AppDelegate` forwards the APNs callbacks here.
@MainActor
final class PushNotificationsManager: NSObject {
    private let apiClient: APIClient
    private let settingsStore: SettingsStore
    /// Chains every registration/teardown so their NETWORK calls cannot
    /// interleave: a client-side abort of a superseded flip is not enough,
    /// because its DELETE was already in flight and could land at the server
    /// after the newer flip's re-registration POST for the same token —
    /// silently unregistering a device whose toggle reads on. Each operation
    /// awaits its predecessor; a superseded one exits before touching the
    /// network.
    private var operationChain: Task<Void, Never>?

    init(apiClient: APIClient, settingsStore: SettingsStore) {
        self.apiClient = apiClient
        self.settingsStore = settingsStore
        super.init()
        // Foreground presentation is handled below: the app's own toasts
        // already cover order events on screen, so the system banner is for
        // backgrounded delivery only (where the delegate is never asked).
        UNUserNotificationCenter.current().delegate = self
    }

    /// Authenticated-screen appear: with the toggle on, re-register so the
    /// server always holds a current token under the CURRENT account — APNs
    /// tokens rotate between launches, and a login after a logout re-binds
    /// the device here. With the toggle off, sweep any registration an
    /// earlier session left stranded (a session expiry dies with no valid
    /// credentials to DELETE with; unregistration is possession-authorized
    /// server-side, so the new login's credentials clear it).
    func start() {
        if settingsStore.pushNotificationsEnabled {
            UIApplication.shared.registerForRemoteNotifications()
            return
        }
        guard let stranded = settingsStore.pushDeviceToken else { return }
        enqueue { [apiClient, settingsStore] in
            try? await apiClient.unregisterDevice(token: stranded)
            settingsStore.pushDeviceToken = nil
        }
    }

    /// The Profile toggle. Enabling asks for authorization then registers;
    /// a denial reverts the stored setting (the caller re-reads it).
    /// Disabling deletes the uploaded token server-side, then stops APNs.
    /// The work runs on the operation chain; a flip superseded by a newer one
    /// exits before its network call, so rapid OFF→ON can never end with the
    /// OFF's DELETE landing after the ON's re-registration.
    func setEnabled(_ enabled: Bool) async {
        settingsStore.pushNotificationsEnabled = enabled
        await enqueue { [weak self] in
            await self?.apply(enabled: enabled)
        }.value
    }

    private func apply(enabled: Bool) async {
        // Superseded by a newer flip: leave the network alone — the newer
        // operation, queued behind this one, expresses the current intent.
        guard settingsStore.pushNotificationsEnabled == enabled else { return }
        switch PushRegistrationFlow.onToggle(enabled: enabled, uploadedToken: settingsStore.pushDeviceToken) {
        case .requestAuthorization:
            let granted = (try? await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            guard settingsStore.pushNotificationsEnabled else { return }
            switch PushRegistrationFlow.onAuthorization(granted: granted) {
            case .registerWithAPNs:
                UIApplication.shared.registerForRemoteNotifications()
            default:
                settingsStore.pushNotificationsEnabled = false
            }
        case .unregister(let uploadedToken):
            if let uploadedToken {
                // Best-effort: a failed DELETE leaves a token the server will
                // prune when its pushes start bouncing.
                try? await apiClient.unregisterDevice(token: uploadedToken)
                settingsStore.pushDeviceToken = nil
            }
            guard !settingsStore.pushNotificationsEnabled else { return }
            UIApplication.shared.unregisterForRemoteNotifications()
        default:
            break
        }
    }

    /// Sign-out teardown, called from EVERY sign-out route (Profile logout,
    /// the app-lock escape hatch, a server switch) while the departing
    /// account's credentials are still valid: the token registration belongs
    /// to the ACCOUNT, and the next login on this device must not inherit its
    /// pushes. The preference itself is device-level and survives; the next
    /// authenticated `start()` re-registers under the new account.
    func handleLogout() async {
        await enqueue { [apiClient, settingsStore] in
            if let token = settingsStore.pushDeviceToken {
                try? await apiClient.unregisterDevice(token: token)
                settingsStore.pushDeviceToken = nil
            }
            UIApplication.shared.unregisterForRemoteNotifications()
        }.value
    }

    /// Appends an operation to the chain and returns its task. Operations run
    /// strictly one after another, in enqueue order.
    @discardableResult
    private func enqueue(_ operation: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        let previous = operationChain
        let task = Task { @MainActor in
            await previous?.value
            await operation()
        }
        operationChain = task
        return task
    }

    /// AppDelegate forward: APNs granted a token — upload it. Runs on the
    /// operation chain so the POST can never interleave with a teardown's
    /// DELETE; a late callback after opt-out is dropped, and an opt-out that
    /// raced the upload gets its registration undone.
    func didRegisterForRemoteNotifications(deviceToken: Data) {
        let token = PushTokenEncoding.hexString(deviceToken)
        guard settingsStore.pushNotificationsEnabled, !token.isEmpty else { return }
        enqueue { [apiClient, settingsStore] in
            guard settingsStore.pushNotificationsEnabled else { return }
            do {
                try await apiClient.registerDevice(token: token)
                if settingsStore.pushNotificationsEnabled {
                    settingsStore.pushDeviceToken = token
                } else {
                    // Opted out while the upload was in flight — undo it.
                    try? await apiClient.unregisterDevice(token: token)
                }
            } catch {
                // Best-effort: registration retries on the next launch or
                // toggle; pushes are auxiliary to the in-app order stream.
            }
        }
    }

    /// AppDelegate forward: APNs registration failed (simulator, no network).
    /// The setting stays on — registration retries on the next launch.
    func didFailToRegisterForRemoteNotifications(error: Error) {
        // Nothing actionable for the user here.
    }
}

extension PushNotificationsManager: UNUserNotificationCenterDelegate {
    /// Foreground pushes show nothing — the trade screen's toasts already
    /// carry order events while the app is up. Backgrounded delivery keeps
    /// the OS banner (this delegate is only consulted in the foreground).
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([])
    }
}
