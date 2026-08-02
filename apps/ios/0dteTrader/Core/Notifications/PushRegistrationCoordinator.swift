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
    /// Explicitly nonisolated: the @MainActor protocol conformance would
    /// otherwise isolate the implicit memberwise init too, and this type is
    /// constructed as a DEFAULT ARGUMENT (a nonisolated context) below.
    nonisolated init() {}

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
    /// One serial chain per server, held HERE rather than on the manager:
    /// a container swap builds a new manager for the same server, and the
    /// two must still serialize. The APNs token is device-scoped, so a
    /// departed manager's DELETE and the new one's POST address the same
    /// server row — only ordering can keep the survivor correct.
    private var chains: [String: Task<Void, Never>] = [:]

    init(registry: RemoteNotificationRegistry = UIApplicationRemoteNotificationRegistry()) {
        self.registry = registry
        // Installed at the app level, not on any screen: a refresh-token
        // rejection can strike from any authenticated API call, and delivery
        // for the dead session must stop no matter which view made it.
        //
        // `[weak self]` on the OUTER block, not merely the inner Task: a
        // capture list is evaluated when its closure is created, so an inner
        // list forces the outer block to capture self — strongly, absent its
        // own list — and NotificationCenter holds that block until
        // removeObserver, which only deinit calls. The observer would keep
        // the coordinator alive forever and make its own cleanup dead code.
        sessionObserver = NotificationCenter.default.addObserver(
            forName: .sessionDidBecomeUnauthenticated,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.handleSessionExpired() }
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

    // MARK: - Per-server operation chain

    /// Appends server-side registration work to `serverKey`'s serial chain.
    /// Operations for one server run strictly in enqueue order, ACROSS
    /// manager instances — the guarantee a per-manager chain loses the
    /// moment a server switch (or a switch back) replaces the container.
    @discardableResult
    func enqueue(
        serverKey: String,
        _ operation: @escaping @MainActor () async -> Void
    ) -> Task<Void, Never> {
        let previous = chains[serverKey]
        let task = Task { @MainActor in
            await previous?.value
            await operation()
        }
        chains[serverKey] = task
        return task
    }

    #if DEBUG
    /// Awaits everything currently queued for one server (tests only).
    func drainOperationsForTesting(serverKey: String) async {
        await chains[serverKey]?.value
    }
    #endif

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
