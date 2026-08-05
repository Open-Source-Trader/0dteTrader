import UIKit

/// UIKit shim for the pure-SwiftUI app. APNs registration results only ever
/// arrive on a `UIApplicationDelegate`, so this exists to forward them to the
/// app-lifetime `PushRegistrationCoordinator`, which routes them to whichever
/// server's manager owns the current registration era — wired once by
/// `ZeroDTETraderApp` and never re-wired, since the coordinator outlives every
/// server switch.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    var pushCoordinator: PushRegistrationCoordinator?

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        pushCoordinator?.didRegisterForRemoteNotifications(deviceToken: deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        pushCoordinator?.didFailToRegisterForRemoteNotifications(error: error)
    }
}
