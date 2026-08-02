import UIKit

/// UIKit shim for the pure-SwiftUI app. APNs registration results only ever
/// arrive on a `UIApplicationDelegate`, so this exists to forward them to the
/// container's `PushNotificationsManager` — wired by `ZeroDTETraderApp`, and
/// re-wired when a server switch rebuilds the container.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    var pushNotifications: PushNotificationsManager?

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        pushNotifications?.didRegisterForRemoteNotifications(deviceToken: deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        pushNotifications?.didFailToRegisterForRemoteNotifications(error: error)
    }
}
