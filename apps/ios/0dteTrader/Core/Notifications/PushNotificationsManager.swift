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

    init(apiClient: APIClient, settingsStore: SettingsStore) {
        self.apiClient = apiClient
        self.settingsStore = settingsStore
        super.init()
        // Foreground presentation is handled below: the app's own toasts
        // already cover order events on screen, so the system banner is for
        // backgrounded delivery only (where the delegate is never asked).
        UNUserNotificationCenter.current().delegate = self
    }

    /// App launch: with the toggle on, re-register so the server always holds
    /// a current token — APNs tokens can rotate between launches.
    func start() {
        guard settingsStore.pushNotificationsEnabled else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// The Profile toggle. Enabling asks for authorization then registers;
    /// a denial reverts the stored setting (the caller re-reads it).
    /// Disabling deletes the uploaded token server-side, then stops APNs.
    func setEnabled(_ enabled: Bool) async {
        settingsStore.pushNotificationsEnabled = enabled
        switch PushRegistrationFlow.onToggle(enabled: enabled, uploadedToken: settingsStore.pushDeviceToken) {
        case .requestAuthorization:
            let granted = (try? await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])) ?? false
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
            UIApplication.shared.unregisterForRemoteNotifications()
        default:
            break
        }
    }

    /// AppDelegate forward: APNs granted a token — upload it.
    func didRegisterForRemoteNotifications(deviceToken: Data) {
        let token = PushTokenEncoding.hexString(deviceToken)
        Task {
            do {
                try await apiClient.registerDevice(token: token)
                settingsStore.pushDeviceToken = token
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
