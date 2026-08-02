import UIKit

/// The device-global half of push registration — UIApplication's
/// register/unregister pair — behind a seam so tests can observe the calls
/// without UIKit.
@MainActor
protocol RemoteNotificationRegistry {
    func registerForRemoteNotifications()
    func unregisterForRemoteNotifications()
}

struct UIApplicationRemoteNotificationRegistry: RemoteNotificationRegistry {
    func registerForRemoteNotifications() {
        UIApplication.shared.registerForRemoteNotifications()
    }

    func unregisterForRemoteNotifications() {
        UIApplication.shared.unregisterForRemoteNotifications()
    }
}

/// App-lifetime owner of the DEVICE-GLOBAL push state. Exactly one exists,
/// created by `ZeroDTETraderApp` and surviving every server switch; the
/// per-server `PushNotificationsManager`s ask it to start and stop delivery
/// instead of touching `UIApplication` themselves.
///
/// Why it exists: stopping local delivery must never depend on a network
/// call succeeding. Logout, session expiry, a server switch, and the
/// notifications toggle all deactivate HERE, synchronously — the server-side
/// DELETE that follows is separate bookkeeping that may fail and be retried
/// later. And because APNs callbacks arrive device-globally, this object
/// routes them to the one server binding that is current, stamped with a
/// generation the binding's async work must present before its results count.
@MainActor
final class PushRegistrationCoordinator {
    /// The server registration currently allowed to receive APNs callbacks.
    /// `manager` is weak: a departed container's manager is kept alive by its
    /// own pending operations, not by this routing table.
    private struct ActiveBinding {
        let serverKey: String
        let generation: Int
        weak var manager: PushNotificationsManager?
    }

    private let registry: RemoteNotificationRegistry
    private var active: ActiveBinding?
    /// Monotonic era counter. Every activation AND deactivation moves it, so
    /// an async result stamped with an old generation can prove itself stale.
    private(set) var generation = 0
    private var sessionObserver: NSObjectProtocol?

    init(registry: RemoteNotificationRegistry = UIApplicationRemoteNotificationRegistry()) {
        self.registry = registry
        // Installed at the app level, not on any screen: a refresh-token
        // rejection can strike from any authenticated API call, and delivery
        // for the dead session must stop no matter which view made it.
        sessionObserver = NotificationCenter.default.addObserver(
            forName: .sessionDidBecomeUnauthenticated,
            object: nil,
            queue: .main
        ) { _ in
            Task { @MainActor [weak self] in self?.handleSessionExpired() }
        }
    }

    deinit {
        if let sessionObserver {
            NotificationCenter.default.removeObserver(sessionObserver)
        }
    }

    /// Begins a registration era for `manager`'s server: APNs callbacks route
    /// there until the next activation or deactivation. Returns the era's
    /// generation for the caller to stamp its async work with.
    func activate(serverKey: String, manager: PushNotificationsManager) -> Int {
        generation += 1
        active = ActiveBinding(serverKey: serverKey, generation: generation, manager: manager)
        registry.registerForRemoteNotifications()
        return generation
    }

    /// Stops local delivery NOW: unbinds the active era and unregisters from
    /// APNs before any network call is made or awaited. Idempotent — calling
    /// it with nothing active still bumps the generation, so an in-flight
    /// result from any earlier era is invalidated either way.
    func deactivate() {
        generation += 1
        active = nil
        registry.unregisterForRemoteNotifications()
    }

    /// Whether (serverKey, generation) still names the active era. Async work
    /// checks this before applying its result; both halves must match — a
    /// generation alone could not tell two servers' eras apart if a stale
    /// value were compared against a re-numbered binding.
    func isCurrent(serverKey: String, generation: Int) -> Bool {
        guard let active else { return false }
        return active.serverKey == serverKey && active.generation == generation
    }

    /// Whether `manager` holds the active era right now — which means its
    /// stored token is a LIVE registration, not one retained from a dead era.
    /// Activation uses this to sweep only stale registrations: an
    /// authenticated screen can re-appear mid-session, and deleting the live
    /// row just to re-create it would open a delivery gap for nothing.
    func isActiveBinding(serverKey: String, manager: PushNotificationsManager) -> Bool {
        guard let active else { return false }
        return active.serverKey == serverKey && active.manager === manager
    }

    /// Session expiry: the credentials just failed, so there is nothing to
    /// DELETE with — stop delivery immediately and leave every server's
    /// retained token where it is; the next successful login on a server
    /// sweeps its slot with credentials that work.
    func handleSessionExpired() {
        deactivate()
    }

    // MARK: - APNs callbacks (AppDelegate forwards)

    /// Routed ONLY to the current era's manager, stamped with that era's
    /// generation. A callback landing after deactivation is dropped here —
    /// there is no binding left that could claim it.
    func didRegisterForRemoteNotifications(deviceToken: Data) {
        guard let active, let manager = active.manager else { return }
        manager.didRegisterForRemoteNotifications(
            deviceToken: deviceToken,
            generation: active.generation
        )
    }

    func didFailToRegisterForRemoteNotifications(error: Error) {
        active?.manager?.didFailToRegisterForRemoteNotifications(error: error)
    }
}
