import Foundation
import UserNotifications

/// APNs device-token encoding, kept pure so it is testable without UIKit.
enum PushTokenEncoding {
    /// Lowercase hex, two digits per byte — the format the backend stores.
    static func hexString(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }
}

/// The two device-registration calls the manager makes, as a seam so tests
/// can script success, failure, and suspension. `APIClient` conforms.
protocol DeviceRegistrationAPI {
    func registerDevice(token: String) async throws
    func unregisterDevice(token: String) async throws
}

extension APIClient: DeviceRegistrationAPI {}

/// Owns ONE server's push registration: uploading the device token under the
/// current account, deleting it on the way out, and the stored-token retry
/// handle for both. The device-global side — actually starting and stopping
/// APNs delivery — belongs to the app-lifetime `PushRegistrationCoordinator`;
/// this manager asks it to activate/deactivate and receives token callbacks
/// routed back with an era generation to validate against.
///
/// Token bookkeeping is PER SERVER (`storedToken` reads a slot keyed by this
/// manager's server): the APNs token is device-scoped and may be registered
/// with several backends over time, and each registration needs its own retry
/// handle. Late operations from a departed era only ever write their own
/// server's slot, and only clear a token they can name — so they can never
/// clobber a newer era's bookkeeping.
@MainActor
final class PushNotificationsManager: NSObject {
    private let apiClient: DeviceRegistrationAPI
    private let settingsStore: SettingsStore
    private let coordinator: PushRegistrationCoordinator
    /// Which server's token slot this manager owns (the API base URL).
    private let serverKey: String
    /// Seam over `UNUserNotificationCenter.requestAuthorization` — the real
    /// one needs an app bundle that unit tests don't have.
    private let requestAuthorization: () async -> Bool

    init(
        apiClient: DeviceRegistrationAPI,
        settingsStore: SettingsStore,
        coordinator: PushRegistrationCoordinator,
        serverKey: String,
        requestAuthorization: (() async -> Bool)? = nil,
        installsNotificationDelegate: Bool = true
    ) {
        self.apiClient = apiClient
        self.settingsStore = settingsStore
        self.coordinator = coordinator
        self.serverKey = serverKey
        self.requestAuthorization = requestAuthorization ?? {
            (try? await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        }
        super.init()
        // Foreground presentation is handled below: the app's own toasts
        // already cover order events on screen, so the system banner is for
        // backgrounded delivery only (where the delegate is never asked).
        // Skipped in unit tests, which run without an app bundle.
        if installsNotificationDelegate {
            UNUserNotificationCenter.current().delegate = self
        }
    }

    /// This server's uploaded-token retry handle.
    private var storedToken: String? {
        get { settingsStore.pushDeviceToken(server: serverKey) }
        set { settingsStore.setPushDeviceToken(newValue, server: serverKey) }
    }

    /// Value-sensitive clear: a stale operation's success names the token it
    /// actually deleted, and must never erase a NEWER token a later era wrote
    /// into the same slot.
    private func clearStoredToken(ifMatches token: String) {
        if storedToken == token { storedToken = nil }
    }

    /// DELETEs `token` server-side and, on success, clears it from the slot.
    /// On failure the slot keeps it — the stored token is the only handle the
    /// next retry (sweep, flip, or login) has.
    private func unregisterAndClear(_ token: String) async {
        if (try? await apiClient.unregisterDevice(token: token)) != nil {
            clearStoredToken(ifMatches: token)
        }
    }

    /// AUTHENTICATED activation — called when an authenticated screen
    /// appears, never merely because the app launched to the login screen.
    /// First sweeps any registration retained from an earlier era on THIS
    /// server (a failed logout DELETE, a session expiry, a rotated token):
    /// unregistration is possession-authorized server-side, so the current
    /// login's credentials clear the previous account's row. Then, with the
    /// toggle on, begins a new era — APNs tokens rotate between launches, and
    /// a login after a logout re-binds the device here.
    func activateAfterAuthentication() {
        // The era this intent belongs to. A logout, expiry, switch, or
        // toggle-off landing before the queued work reaches its activation
        // moves THIS SERVER's counter — and delivery must NOT come back on
        // for a session that ended while this operation was suspended
        // mid-sweep. (Per-server, so a departed server's late expiry cannot
        // kill this one's intent.)
        let intent = coordinator.generation(for: serverKey)
        enqueue { [self] in
            // Swept only when this manager does NOT hold the active era: a
            // token in the slot then is a leftover (previous account, dead
            // session), not the live registration — which a re-appearing
            // screen must not delete just to re-create.
            if let retained = storedToken,
               !coordinator.isActiveBinding(serverKey: serverKey, manager: self) {
                // A failed sweep keeps the handle and registration continues:
                // the POST upserts the token to the current account either
                // way, and the next activation retries the sweep.
                await unregisterAndClear(retained)
            }
            guard coordinator.generation(for: serverKey) == intent,
                  settingsStore.pushNotificationsEnabled else { return }
            _ = coordinator.activate(serverKey: serverKey, manager: self)
        }
    }

    /// The Profile toggle. Disabling stops local delivery IMMEDIATELY —
    /// before any network call, so it cannot depend on a reachable server —
    /// then deletes the uploaded token server-side. Enabling asks for
    /// authorization then registers; a denial reverts the stored setting
    /// (the caller re-reads it). The network work runs on the operation
    /// chain; a flip superseded by a newer one exits before its network call.
    func setEnabled(_ enabled: Bool) async {
        settingsStore.pushNotificationsEnabled = enabled
        if !enabled {
            coordinator.deactivate(serverKey: serverKey)
        }
        // The enable intent is stamped with this server's era NOW: the
        // system authorization prompt can outlive the session, and the
        // resumed continuation must not switch delivery back on for it.
        let intent = coordinator.generation(for: serverKey)
        await enqueue { [weak self] in
            await self?.apply(enabled: enabled, intent: intent)
        }.value
    }

    private func apply(enabled: Bool, intent: Int) async {
        // Superseded by a newer flip: leave the network alone — the newer
        // operation, queued behind this one, expresses the current intent.
        guard settingsStore.pushNotificationsEnabled == enabled else { return }
        if enabled {
            let granted = await requestAuthorization()
            // Re-checked after EVERY await: the toggle preference is
            // device-level and survives a logout or expiry, so it alone
            // cannot prove the session this flip belonged to still exists —
            // the era counter can.
            guard settingsStore.pushNotificationsEnabled == enabled,
                  coordinator.generation(for: serverKey) == intent else { return }
            guard granted else {
                settingsStore.pushNotificationsEnabled = false
                return
            }
            // Sweep a retained registration before re-registering, same as
            // activateAfterAuthentication — the toggle lives on an
            // authenticated screen, so the credentials can clear it.
            if let retained = storedToken {
                await unregisterAndClear(retained)
            }
            guard settingsStore.pushNotificationsEnabled == enabled,
                  coordinator.generation(for: serverKey) == intent else { return }
            _ = coordinator.activate(serverKey: serverKey, manager: self)
        } else if let uploaded = storedToken {
            await unregisterAndClear(uploaded)
        }
    }

    /// Explicit sign-out, called from EVERY sign-out route while the
    /// departing account's credentials still work. Local delivery stops
    /// synchronously, before any await: a slow DELETE must not keep the old
    /// account's pushes flowing, and its eventual failure must not either —
    /// server cleanup and local APNs registration are separate
    /// responsibilities. The caller awaits this before clearing the auth
    /// session, so the DELETE rides credentials that still work.
    func handleLogout() async {
        coordinator.deactivate(serverKey: serverKey)
        await enqueue { [self] in
            // Cleared only on success, and only the exact token deleted:
            // with the DELETE failed (the case an expiring session forces),
            // the kept token is what lets the NEXT login's sweep clear the
            // registration — unregistration is possession-authorized
            // server-side for precisely this handoff.
            if let token = storedToken {
                await unregisterAndClear(token)
            }
        }.value
    }

    /// Server switch: delivery and the callback era stop synchronously so
    /// nothing from this server's registration survives into the next
    /// container. The DELETE is best-effort — the switch UI is only
    /// reachable while unauthenticated, so it usually fails and the retained
    /// slot is healed by the next sign-in on this server instead.
    func handleServerSwitch() {
        coordinator.deactivate(serverKey: serverKey)
        enqueue { [self] in
            if let token = storedToken {
                await unregisterAndClear(token)
            }
        }
    }

    #if DEBUG
    /// Awaits every operation currently queued for this server (tests only).
    func drainOperationsForTesting() async {
        await coordinator.drainOperationsForTesting(serverKey: serverKey)
    }
    #endif

    /// Appends an operation to THIS SERVER's chain (owned by the coordinator,
    /// so ordering survives a container swap) and returns its task. Their
    /// NETWORK calls therefore cannot interleave: each operation awaits its
    /// predecessor, and a superseded one exits before touching the network.
    /// Local delivery is NOT chained — the coordinator stops it
    /// synchronously — this chain is only the server-side bookkeeping.
    /// Operations capture `self` strongly on purpose: a departed era's op
    /// must still finish its own server's bookkeeping.
    @discardableResult
    private func enqueue(_ operation: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        coordinator.enqueue(serverKey: serverKey, operation)
    }

    /// Coordinator forward: APNs granted a token for era `generation`. The
    /// POST runs on the operation chain, and every await re-verifies the era
    /// still stands — a logout, switch, or toggle-off may have landed while
    /// the upload was in flight, and a departed account's delivery must not
    /// quietly resume.
    func didRegisterForRemoteNotifications(deviceToken: Data, generation: Int) {
        let token = PushTokenEncoding.hexString(deviceToken)
        guard !token.isEmpty else { return }
        enqueue { [self] in
            guard coordinator.isCurrent(serverKey: serverKey, generation: generation),
                  settingsStore.pushNotificationsEnabled else { return }
            // Rotation: a DIFFERENT token retained in the slot is a server
            // row this POST will not replace (rows are keyed by token), so
            // sweep it first. If the sweep fails the handle is overwritten
            // below — the dead token's row is then pruned when APNs reports
            // it Unregistered, which the backend already handles.
            if let old = storedToken, old != token {
                await unregisterAndClear(old)
            }
            do {
                try await apiClient.registerDevice(token: token)
                if coordinator.isCurrent(serverKey: serverKey, generation: generation),
                   settingsStore.pushNotificationsEnabled {
                    storedToken = token
                } else {
                    // The era ended while the upload was in flight —
                    // compensate. A failed compensation retains the token so
                    // the next sweep retries the deletion.
                    if (try? await apiClient.unregisterDevice(token: token)) == nil {
                        storedToken = token
                    }
                }
            } catch {
                // Best-effort: registration retries on the next activation;
                // pushes are auxiliary to the in-app order stream.
            }
        }
    }

    /// Coordinator forward: APNs registration failed (simulator, no network).
    /// The setting stays on — registration retries on the next activation.
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
