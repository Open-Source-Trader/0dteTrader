import XCTest
@testable import ZeroDTETrader

/// The push lifecycle's race matrix: stale asynchronous operations from
/// departed eras, the Profile toggle's flips (including an authorization
/// prompt that outlives the session), server switches, and per-server token
/// slots. Fixture and fakes: PushTestSupport.swift.
@MainActor
final class PushLifecycleRaceTests: PushLifecycleTestCase {
    // MARK: Stale asynchronous operations

    func testDelayedLogoutDelete_cannotDisturbALaterLogin() async {
        settings.pushNotificationsEnabled = true
        settings.setPushDeviceToken("old0", server: serverA)
        api.holdNextUnregister = true
        let manager = makeManager()
        let logout = Task { await manager.handleLogout() }
        await waitUntil { self.api.unregisterCalls.count == 1 }
        // Next login begins while the old DELETE is still in flight; its
        // work queues on the same chain, strictly after the DELETE.
        manager.activateAfterAuthentication()
        api.releaseHeld()
        await awaitOrFail("logout") { await logout.value }
        await awaitOrFail("drain") { await manager.drainOperationsForTesting() }
        coordinator.didRegisterForRemoteNotifications(deviceToken: tokenData)
        await awaitOrFail("drain") { await manager.drainOperationsForTesting() }
        XCTAssertEqual(api.registered, [tokenHex])
        XCTAssertEqual(settings.pushDeviceToken(server: serverA), tokenHex)
        // The delayed DELETE cleared only its own token; the login's fresh
        // registration and stored token stand.
        XCTAssertFalse(api.unregisterCalls.contains(tokenHex))
    }

    func testDelayedServerAOperation_cannotModifyServerBState() async {
        settings.pushNotificationsEnabled = true
        settings.setPushDeviceToken("tokA", server: serverA)
        api.holdNextUnregister = true
        api.unregisterFails = true
        let managerA = makeManager(serverKey: serverA)
        let logoutA = Task { await managerA.handleLogout() }
        await waitUntil { self.api.unregisterCalls.count == 1 }

        let managerB = makeManager(serverKey: serverB)
        managerB.activateAfterAuthentication()
        await awaitOrFail("drain") { await managerB.drainOperationsForTesting() }
        coordinator.didRegisterForRemoteNotifications(deviceToken: tokenData)
        await awaitOrFail("drain") { await managerB.drainOperationsForTesting() }
        XCTAssertEqual(settings.pushDeviceToken(server: serverB), tokenHex)

        api.releaseHeld()
        await awaitOrFail("logout") { await logoutA.value }
        // A's failed DELETE retained A's token and never touched B's slot.
        XCTAssertEqual(settings.pushDeviceToken(server: serverA), "tokA")
        XCTAssertEqual(settings.pushDeviceToken(server: serverB), tokenHex)
    }

    /// The A→B→A hazard: a departed container's manager and its replacement
    /// serve the SAME server, and the APNs token is device-scoped, so their
    /// DELETE and POST address the same server row. Value-sensitive clearing
    /// cannot separate them (the token value is identical) — only ordering
    /// can, which is why the chain lives on the app-lifetime coordinator
    /// rather than on the manager.
    func testLateDeleteFromADepartedEra_cannotOutraceTheNewEraRegistration() async {
        settings.pushNotificationsEnabled = true
        settings.setPushDeviceToken(tokenHex, server: serverA)
        api.holdNextUnregister = true
        let departed = makeManager(serverKey: serverA)
        let logout = Task { await departed.handleLogout() }
        await waitUntil { self.api.unregisterCalls.count == 1 }

        // The replacement container's manager registers the same token while
        // the departed manager's DELETE is still in flight.
        let current = makeManager(serverKey: serverA)
        _ = coordinator.activate(serverKey: serverA, manager: current)
        coordinator.didRegisterForRemoteNotifications(deviceToken: tokenData)

        api.releaseHeld()
        await awaitOrFail("logout") { await logout.value }
        await awaitOrFail("drain") { await current.drainOperationsForTesting() }

        // The DELETE completed BEFORE the POST began, so the row that
        // survives is the new era's — not a registration silently deleted by
        // a predecessor.
        XCTAssertEqual(api.completions, ["delete:\(tokenHex)", "register:\(tokenHex)"])
        XCTAssertEqual(settings.pushDeviceToken(server: serverA), tokenHex)
    }

    /// A stale DELETE that succeeds must clear only the token it named: the
    /// slot may already hold a newer one.
    func testStaleDeleteSuccess_clearsOnlyTheTokenItDeleted() async {
        settings.pushNotificationsEnabled = true
        settings.setPushDeviceToken("tok1", server: serverA)
        let manager = makeManager(serverKey: serverA)
        api.holdNextUnregister = true
        let logout = Task { await manager.handleLogout() }
        await waitUntil { self.api.unregisterCalls.count == 1 }

        // A newer token lands in the slot while the DELETE is suspended.
        settings.setPushDeviceToken("tok2", server: serverA)

        api.releaseHeld()
        await awaitOrFail("logout") { await logout.value }
        XCTAssertEqual(settings.pushDeviceToken(server: serverA), "tok2")
    }

    /// An activation suspended mid-sweep must not switch delivery back on
    /// when the session it belonged to ended while it waited.
    func testQueuedActivation_doesNotResumeDeliveryAfterLogout() async {
        settings.pushNotificationsEnabled = true
        settings.setPushDeviceToken("old0", server: serverA)
        api.holdNextUnregister = true
        let manager = makeManager()
        manager.activateAfterAuthentication()
        await waitUntil { self.api.unregisterCalls.count == 1 }

        // Logout lands while the activation's sweep is still suspended.
        let logout = Task { await manager.handleLogout() }
        await waitUntil { self.registry.unregisterCount == 1 }

        api.releaseHeld()
        await awaitOrFail("logout") { await logout.value }
        await awaitOrFail("drain") { await manager.drainOperationsForTesting() }

        XCTAssertEqual(registry.registerCount, 0)
        XCTAssertFalse(
            coordinator.isCurrent(serverKey: serverA, generation: coordinator.generation(for: serverA))
        )
    }

    func testTokenCallbackAfterDeactivation_isDroppedEntirely() async {
        settings.pushNotificationsEnabled = true
        let manager = makeManager()
        _ = coordinator.activate(serverKey: serverA, manager: manager)
        coordinator.deactivate(serverKey: serverA)
        coordinator.didRegisterForRemoteNotifications(deviceToken: tokenData)
        await awaitOrFail("drain") { await manager.drainOperationsForTesting() }
        XCTAssertTrue(api.registerCalls.isEmpty)
        XCTAssertNil(settings.pushDeviceToken(server: serverA))
    }

    func testEraEndingMidUpload_compensatesWithDeletion() async {
        settings.pushNotificationsEnabled = true
        api.holdNextRegister = true
        let manager = makeManager()
        _ = coordinator.activate(serverKey: serverA, manager: manager)
        coordinator.didRegisterForRemoteNotifications(deviceToken: tokenData)
        await waitUntil { self.api.registerCalls.count == 1 }
        // Logout lands while the POST is suspended.
        let logout = Task { await manager.handleLogout() }
        await waitUntil { self.registry.unregisterCount == 1 }
        api.releaseHeld()
        await awaitOrFail("logout") { await logout.value }
        await awaitOrFail("drain") { await manager.drainOperationsForTesting() }
        // The POST completed for a dead era: delivery is not reactivated and
        // the registration is compensated away.
        XCTAssertEqual(api.unregistered.last, tokenHex)
        XCTAssertNil(settings.pushDeviceToken(server: serverA))
    }

    func testEraEndingMidUpload_failedCompensationRetainsToken() async {
        settings.pushNotificationsEnabled = true
        api.holdNextRegister = true
        let manager = makeManager()
        _ = coordinator.activate(serverKey: serverA, manager: manager)
        coordinator.didRegisterForRemoteNotifications(deviceToken: tokenData)
        await waitUntil { self.api.registerCalls.count == 1 }
        let logout = Task { await manager.handleLogout() }
        await waitUntil { self.registry.unregisterCount == 1 }
        api.unregisterFails = true
        api.releaseHeld()
        await awaitOrFail("logout") { await logout.value }
        await awaitOrFail("drain") { await manager.drainOperationsForTesting() }
        // Compensation failed: the token is retained as the sweep's handle.
        XCTAssertEqual(settings.pushDeviceToken(server: serverA), tokenHex)
    }

    // MARK: The Profile toggle

    func testDisable_stopsLocalDeliveryEvenWhenServerUnreachable() async {
        settings.pushNotificationsEnabled = true
        settings.setPushDeviceToken(tokenHex, server: serverA)
        api.unregisterFails = true
        let manager = makeManager()
        _ = coordinator.activate(serverKey: serverA, manager: manager)
        await awaitOrFail("disable") { await manager.setEnabled(false) }
        XCTAssertEqual(registry.unregisterCount, 1)
        XCTAssertEqual(settings.pushDeviceToken(server: serverA), tokenHex)
        XCTAssertFalse(settings.pushNotificationsEnabled)
    }

    func testRapidDisableEnable_landsRegisteredWithOneCleanSweep() async {
        settings.pushNotificationsEnabled = true
        settings.setPushDeviceToken(tokenHex, server: serverA)
        let manager = makeManager()
        let off = Task { await manager.setEnabled(false) }
        // Only the OFF flip's synchronous prefix is ordered ahead of the ON
        // flip; whether its DELETE runs or is superseded stays up to the
        // scheduler — both interleavings must land in the same final state.
        await waitUntil { !self.settings.pushNotificationsEnabled }
        let on = Task { await manager.setEnabled(true) }
        await awaitOrFail("disable") { await off.value }
        await awaitOrFail("enable") { await on.value }
        // Delivery stopped exactly once, the stale registration was deleted
        // exactly once (by the OFF flip or the ON flip's sweep), and the
        // final state is registered.
        XCTAssertTrue(settings.pushNotificationsEnabled)
        XCTAssertEqual(registry.unregisterCount, 1)
        XCTAssertEqual(registry.registerCount, 1)
        XCTAssertEqual(api.unregistered, [tokenHex])
    }

    func testEnable_authorizationDeniedRevertsTheToggle() async {
        settings.pushNotificationsEnabled = false
        let manager = makeManager(authorization: { false })
        await awaitOrFail("enable") { await manager.setEnabled(true) }
        XCTAssertFalse(settings.pushNotificationsEnabled)
        XCTAssertEqual(registry.registerCount, 0)
    }

    /// Control for the gate harness: with nothing intervening, a held prompt
    /// that resolves granted activates normally.
    func testEnable_promptResolvingNormally_activates() async {
        settings.pushNotificationsEnabled = false
        let gate = AuthGate()
        let manager = makeManager(authorization: { await gate.authorize() })
        let enable = Task { await manager.setEnabled(true) }
        await waitUntil("prompt up") { gate.isPromptUp }

        gate.resume(true)
        await awaitOrFail("enable") { await enable.value }

        XCTAssertEqual(registry.registerCount, 1)
    }

    /// The system prompt outlives the session: toggle flips on, the prompt
    /// sits open, the user logs out, THEN grants. The toggle preference is
    /// device-level and survives the logout, so only the era counter can
    /// prove the flip's session ended — delivery must not come back on.
    func testEnable_promptResolvingAfterLogout_doesNotReactivate() async {
        settings.pushNotificationsEnabled = false
        let gate = AuthGate()
        let manager = makeManager(authorization: { await gate.authorize() })
        let enable = Task { await manager.setEnabled(true) }
        await waitUntil("prompt up") { gate.isPromptUp }

        let logout = Task { await manager.handleLogout() }
        await waitUntil("local unregister") { self.registry.unregisterCount == 1 }

        gate.resume(true)
        await awaitOrFail("enable") { await enable.value }
        await awaitOrFail("logout") { await logout.value }

        XCTAssertEqual(registry.registerCount, 0)
        XCTAssertFalse(
            coordinator.isCurrent(serverKey: serverA, generation: coordinator.generation(for: serverA))
        )
    }

    /// Same with a session expiry landing mid-prompt.
    func testEnable_promptResolvingAfterOwnServerExpiry_doesNotReactivate() async {
        settings.pushNotificationsEnabled = false
        let gate = AuthGate()
        let manager = makeManager(authorization: { await gate.authorize() })
        let enable = Task { await manager.setEnabled(true) }
        await waitUntil("prompt up") { gate.isPromptUp }

        coordinator.handleSessionExpired(serverKey: serverA)

        gate.resume(true)
        await awaitOrFail("enable") { await enable.value }

        XCTAssertEqual(registry.registerCount, 0)
    }

    /// A FOREIGN server's expiry mid-prompt must not veto this server's
    /// flip — the per-server counters keep the two apart.
    func testEnable_promptResolvingAfterForeignExpiry_stillActivates() async {
        settings.pushNotificationsEnabled = false
        let gate = AuthGate()
        let manager = makeManager(authorization: { await gate.authorize() })
        let enable = Task { await manager.setEnabled(true) }
        await waitUntil("prompt up") { gate.isPromptUp }

        coordinator.handleSessionExpired(serverKey: serverB)

        gate.resume(true)
        await awaitOrFail("enable") { await enable.value }

        XCTAssertEqual(registry.registerCount, 1)
    }

    // MARK: Server switch

    func testServerSwitch_deactivatesSynchronouslyAndRetainsTokenOnFailedCleanup() async {
        settings.pushNotificationsEnabled = true
        settings.setPushDeviceToken(tokenHex, server: serverA)
        api.unregisterFails = true
        let manager = makeManager()
        _ = coordinator.activate(serverKey: serverA, manager: manager)
        manager.handleServerSwitch()
        // Local delivery stopped before the (failing) cleanup attempt.
        XCTAssertEqual(registry.unregisterCount, 1)
        await awaitOrFail("drain") { await manager.drainOperationsForTesting() }
        XCTAssertEqual(api.unregisterCalls, [tokenHex])
        XCTAssertEqual(settings.pushDeviceToken(server: serverA), tokenHex)
    }

    // MARK: Per-server token slots

    /// The retry handle is keyed per server: writing one server's slot must
    /// never disturb another's, and clearing removes only its own.
    func testPushDeviceToken_slotsAreIsolatedPerServer() {
        settings.setPushDeviceToken("aa11", server: serverA)
        settings.setPushDeviceToken("bb22", server: serverB)
        XCTAssertEqual(settings.pushDeviceToken(server: serverA), "aa11")
        XCTAssertEqual(settings.pushDeviceToken(server: serverB), "bb22")

        settings.setPushDeviceToken(nil, server: serverA)
        XCTAssertNil(settings.pushDeviceToken(server: serverA))
        XCTAssertEqual(settings.pushDeviceToken(server: serverB), "bb22")
    }
}
