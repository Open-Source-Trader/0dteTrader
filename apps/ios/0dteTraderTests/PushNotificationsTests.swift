import XCTest
@testable import ZeroDTETrader

/// The push lifecycle against fake APNs and API clients: local delivery must
/// stop without a network round trip, server cleanup must retain its retry
/// handle on failure, and session expiry must stay scoped to the server whose
/// credentials actually failed. Fixture and fakes: PushTestSupport.swift.
@MainActor
final class PushNotificationsTests: PushLifecycleTestCase {
    // MARK: Token hex encoding

    func testHexString_encodesLowercaseTwoDigitsPerByte() {
        XCTAssertEqual(PushTokenEncoding.hexString(Data([0x00, 0xAB, 0xFF, 0x10, 0x7F])), "00abff107f")
    }

    func testHexString_emptyTokenIsEmptyString() {
        XCTAssertEqual(PushTokenEncoding.hexString(Data()), "")
    }

    func testHexString_singleByteKeepsLeadingZero() {
        XCTAssertEqual(PushTokenEncoding.hexString(Data([0x05])), "05")
    }

    // MARK: Registration only after authenticated activation

    func testConstruction_neverRegisters() {
        settings.pushNotificationsEnabled = true
        _ = makeManager()
        XCTAssertEqual(registry.registerCount, 0)
        XCTAssertTrue(api.registerCalls.isEmpty)
    }

    func testActivateAfterAuthentication_toggleOn_registers() async {
        settings.pushNotificationsEnabled = true
        let manager = makeManager()
        manager.activateAfterAuthentication()
        await awaitOrFail("drain") { await manager.drainOperationsForTesting() }
        XCTAssertEqual(registry.registerCount, 1)
    }

    func testActivateAfterAuthentication_toggleOff_sweepsRetainedTokenOnly() async {
        settings.pushNotificationsEnabled = false
        settings.setPushDeviceToken(tokenHex, server: serverA)
        let manager = makeManager()
        manager.activateAfterAuthentication()
        await awaitOrFail("drain") { await manager.drainOperationsForTesting() }
        XCTAssertEqual(api.unregistered, [tokenHex])
        XCTAssertNil(settings.pushDeviceToken(server: serverA))
        XCTAssertEqual(registry.registerCount, 0)
    }

    func testActivateAfterAuthentication_sweepsBeforeRegistering() async {
        settings.pushNotificationsEnabled = true
        settings.setPushDeviceToken(tokenHex, server: serverA)
        let manager = makeManager()
        manager.activateAfterAuthentication()
        await awaitOrFail("drain") { await manager.drainOperationsForTesting() }
        // The retained registration was deleted, then a fresh era began.
        XCTAssertEqual(api.unregistered, [tokenHex])
        XCTAssertEqual(registry.registerCount, 1)
        XCTAssertNil(settings.pushDeviceToken(server: serverA))
    }

    // MARK: Token upload

    func testTokenCallback_postsAndStores() async {
        settings.pushNotificationsEnabled = true
        let manager = makeManager()
        manager.activateAfterAuthentication()
        await awaitOrFail("drain") { await manager.drainOperationsForTesting() }
        coordinator.didRegisterForRemoteNotifications(deviceToken: tokenData)
        await awaitOrFail("drain") { await manager.drainOperationsForTesting() }
        XCTAssertEqual(api.registered, [tokenHex])
        XCTAssertEqual(settings.pushDeviceToken(server: serverA), tokenHex)
    }

    func testTokenCallback_failedPostStoresNothing() async {
        settings.pushNotificationsEnabled = true
        api.registerFails = true
        let manager = makeManager()
        manager.activateAfterAuthentication()
        await awaitOrFail("drain") { await manager.drainOperationsForTesting() }
        coordinator.didRegisterForRemoteNotifications(deviceToken: tokenData)
        await awaitOrFail("drain") { await manager.drainOperationsForTesting() }
        XCTAssertNil(settings.pushDeviceToken(server: serverA))
    }

    func testTokenRotation_sweepsOldRowThenStoresNewToken() async {
        settings.pushNotificationsEnabled = true
        settings.setPushDeviceToken("old0", server: serverA)
        let manager = makeManager()
        _ = coordinator.activate(serverKey: serverA, manager: manager)
        coordinator.didRegisterForRemoteNotifications(deviceToken: tokenData)
        await awaitOrFail("drain") { await manager.drainOperationsForTesting() }
        // The old token's server row is keyed by token — the new POST would
        // not replace it, so it is deleted before the new token is stored.
        XCTAssertEqual(api.unregistered, ["old0"])
        XCTAssertEqual(api.registered, [tokenHex])
        XCTAssertEqual(settings.pushDeviceToken(server: serverA), tokenHex)
    }

    // MARK: Explicit logout

    func testLogout_unregistersLocallyAndDeletesServerRow() async {
        settings.pushNotificationsEnabled = true
        settings.setPushDeviceToken(tokenHex, server: serverA)
        let manager = makeManager()
        await awaitOrFail("logout") { await manager.handleLogout() }
        XCTAssertEqual(registry.unregisterCount, 1)
        XCTAssertEqual(api.unregistered, [tokenHex])
        XCTAssertNil(settings.pushDeviceToken(server: serverA))
    }

    func testLogout_failedDeleteStillUnregistersLocallyAndRetainsToken() async {
        settings.pushNotificationsEnabled = true
        settings.setPushDeviceToken(tokenHex, server: serverA)
        api.unregisterFails = true
        let manager = makeManager()
        await awaitOrFail("logout") { await manager.handleLogout() }
        XCTAssertEqual(registry.unregisterCount, 1)
        XCTAssertEqual(settings.pushDeviceToken(server: serverA), tokenHex)
    }

    func testLogout_localUnregisterDoesNotWaitForTheDelete() async {
        settings.pushNotificationsEnabled = true
        settings.setPushDeviceToken(tokenHex, server: serverA)
        api.holdNextUnregister = true
        let manager = makeManager()
        let logout = Task { await manager.handleLogout() }
        // Local delivery stops before the DELETE has even been sent — the
        // whole point: teardown cannot depend on a reachable server.
        await waitUntil("local unregister") { self.registry.unregisterCount == 1 }
        XCTAssertEqual(registry.unregisterCount, 1)
        XCTAssertTrue(api.unregistered.isEmpty)

        // Only now is the DELETE in flight and parked on its continuation.
        // Releasing before it reaches the fake would resume nothing, and the
        // call would then suspend forever with no one left to wake it — the
        // deadlock that wedged this suite until every await gained a
        // deadline. Waiting on the CALL (recorded before the fake suspends)
        // is what makes the release land.
        await waitUntil("delete in flight") { self.api.unregisterCalls.count == 1 }
        XCTAssertTrue(api.unregistered.isEmpty)
        api.releaseHeld()
        await awaitOrFail("logout") { await logout.value }
        XCTAssertEqual(api.unregistered, [tokenHex])
    }

    // MARK: Session expiry

    func testSessionExpiry_unregistersLocallyWithoutNetworkAndRetainsToken() async {
        settings.pushNotificationsEnabled = true
        settings.setPushDeviceToken(tokenHex, server: serverA)
        let manager = makeManager()
        _ = coordinator.activate(serverKey: serverA, manager: manager)
        coordinator.handleSessionExpired(serverKey: serverA)
        XCTAssertEqual(registry.unregisterCount, 1)
        XCTAssertTrue(api.unregisterCalls.isEmpty)
        XCTAssertEqual(settings.pushDeviceToken(server: serverA), tokenHex)
    }

    func testSessionExpiryNotification_reachesTheCoordinator() async {
        settings.pushNotificationsEnabled = true
        let manager = makeManager()
        _ = coordinator.activate(serverKey: serverA, manager: manager)
        NotificationCenter.default.post(
            name: .sessionDidBecomeUnauthenticated,
            object: nil,
            userInfo: [SessionStore.serverKeyUserInfoKey: serverA]
        )
        await waitUntil { self.registry.unregisterCount == 1 }
        XCTAssertEqual(registry.unregisterCount, 1)
    }

    /// A departed server's late 401 arrives after a switch. It must not
    /// touch the current server's delivery, binding, or token slot — the
    /// exact cross-container false positive `object: nil` observers had.
    func testForeignServerExpiry_leavesTheCurrentServerAlone() async {
        settings.pushNotificationsEnabled = true
        settings.setPushDeviceToken(tokenHex, server: serverA)
        let manager = makeManager()
        let generation = coordinator.activate(serverKey: serverA, manager: manager)

        coordinator.handleSessionExpired(serverKey: serverB)

        XCTAssertEqual(registry.unregisterCount, 0)
        XCTAssertTrue(coordinator.isCurrent(serverKey: serverA, generation: generation))
        XCTAssertEqual(settings.pushDeviceToken(server: serverA), tokenHex)
    }

    func testForeignServerExpiryNotification_isIgnored() async {
        settings.pushNotificationsEnabled = true
        let manager = makeManager()
        let generation = coordinator.activate(serverKey: serverA, manager: manager)

        NotificationCenter.default.post(
            name: .sessionDidBecomeUnauthenticated,
            object: nil,
            userInfo: [SessionStore.serverKeyUserInfoKey: serverB]
        )
        // Let the observer's main-actor hop land before asserting nothing moved.
        for _ in 0..<20 { await Task.yield() }

        XCTAssertEqual(registry.unregisterCount, 0)
        XCTAssertTrue(coordinator.isCurrent(serverKey: serverA, generation: generation))
    }

    /// Fix-1/fix-2 interaction: a foreign server's expiry must not kill the
    /// CURRENT server's pending activation (per-server generations — a
    /// global counter fails this), while the server's own expiry must.
    func testForeignServerExpiry_doesNotKillPendingActivation() async {
        settings.pushNotificationsEnabled = true
        settings.setPushDeviceToken("old0", server: serverA)
        api.holdNextUnregister = true
        let manager = makeManager()
        manager.activateAfterAuthentication()
        await waitUntil { self.api.unregisterCalls.count == 1 }

        coordinator.handleSessionExpired(serverKey: serverB)

        api.releaseHeld()
        await awaitOrFail("drain") { await manager.drainOperationsForTesting() }
        XCTAssertEqual(registry.registerCount, 1)
    }

    func testOwnServerExpiry_killsPendingActivation() async {
        settings.pushNotificationsEnabled = true
        settings.setPushDeviceToken("old0", server: serverA)
        api.holdNextUnregister = true
        let manager = makeManager()
        manager.activateAfterAuthentication()
        await waitUntil { self.api.unregisterCalls.count == 1 }

        coordinator.handleSessionExpired(serverKey: serverA)

        api.releaseHeld()
        await awaitOrFail("drain") { await manager.drainOperationsForTesting() }
        XCTAssertEqual(registry.registerCount, 0)
    }
}
