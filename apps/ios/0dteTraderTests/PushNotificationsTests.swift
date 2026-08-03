import XCTest
@testable import ZeroDTETrader

// MARK: - Fakes

/// Records the device-global register/unregister calls the coordinator makes.
@MainActor
private final class RegistryFake: RemoteNotificationRegistry {
    private(set) var registerCount = 0
    private(set) var unregisterCount = 0

    func registerForRemoteNotifications() { registerCount += 1 }
    func unregisterForRemoteNotifications() { unregisterCount += 1 }
}

/// Scriptable device-registration API: records every call, fails on demand,
/// and can hold the next call open until the test releases it — the seam the
/// staleness-race tests are built on.
@MainActor
private final class DeviceAPIFake: DeviceRegistrationAPI {
    struct Failure: Error {}

    /// Every call, in order, whether it later succeeded or not.
    private(set) var registerCalls: [String] = []
    private(set) var unregisterCalls: [String] = []
    /// Calls that completed successfully.
    private(set) var registered: [String] = []
    private(set) var unregistered: [String] = []
    /// One interleaved log of COMPLETIONS across both calls — the only way
    /// to tell "the DELETE finished before the POST started" from "both were
    /// in flight together", which is exactly what serialization guarantees.
    private(set) var completions: [String] = []
    var registerFails = false
    var unregisterFails = false
    var holdNextRegister = false
    var holdNextUnregister = false
    private var held: [CheckedContinuation<Void, Never>] = []

    func registerDevice(token: String) async throws {
        registerCalls.append(token)
        if holdNextRegister {
            holdNextRegister = false
            await withCheckedContinuation { held.append($0) }
        }
        if registerFails { throw Failure() }
        registered.append(token)
        completions.append("register:\(token)")
    }

    func unregisterDevice(token: String) async throws {
        unregisterCalls.append(token)
        if holdNextUnregister {
            holdNextUnregister = false
            await withCheckedContinuation { held.append($0) }
        }
        if unregisterFails { throw Failure() }
        unregistered.append(token)
        completions.append("delete:\(token)")
    }

    func releaseHeld() {
        let continuations = held
        held = []
        continuations.forEach { $0.resume() }
    }
}

/// Holds the system authorization prompt open, so a teardown can land while
/// the user is still looking at it. The manager's `requestAuthorization`
/// seam is a bare closure, so the gate lives here rather than in the API
/// fake.
@MainActor
private final class AuthGate {
    private(set) var continuation: CheckedContinuation<Bool, Never>?

    var isPromptUp: Bool { continuation != nil }

    func authorize() async -> Bool {
        await withCheckedContinuation { continuation = $0 }
    }

    func resume(_ granted: Bool) {
        continuation?.resume(returning: granted)
        continuation = nil
    }
}

// MARK: - Tests

/// The push lifecycle against fake APNs and API clients: local delivery must
/// stop without a network round trip, server cleanup must retain its retry
/// handle on failure, and stale asynchronous results must never touch a newer
/// era's state.
@MainActor
final class PushNotificationsTests: XCTestCase {
    private let serverA = "https://a.example"
    private let serverB = "https://b.example"
    private let tokenData = Data([0xAA, 0x11])
    private let tokenHex = "aa11"

    private var suiteName: String!
    private var defaults: UserDefaults!
    private var settings: SettingsStore!
    private var registry: RegistryFake!
    private var api: DeviceAPIFake!
    private var coordinator: PushRegistrationCoordinator!

    override func setUp() {
        super.setUp()
        suiteName = "test.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        settings = SettingsStore(defaults: defaults)
        registry = RegistryFake()
        api = DeviceAPIFake()
        coordinator = PushRegistrationCoordinator(registry: registry)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private func makeManager(
        serverKey: String? = nil,
        authorization: @escaping () async -> Bool = { true }
    ) -> PushNotificationsManager {
        PushNotificationsManager(
            apiClient: api,
            settingsStore: settings,
            coordinator: coordinator,
            serverKey: serverKey ?? serverA,
            requestAuthorization: authorization,
            installsNotificationDelegate: false
        )
    }

    /// Spins the main actor until `condition` holds, failing on a deadline
    /// rather than spinning forever.
    private func waitUntil(
        _ description: String = "condition",
        file: StaticString = #filePath,
        line: UInt = #line,
        _ condition: () -> Bool
    ) async {
        let deadline = Date().addingTimeInterval(Self.deadlineSeconds)
        while !condition() {
            if Date() > deadline {
                XCTFail("timed out waiting for \(description)", file: file, line: line)
                return
            }
            await Task.yield()
        }
    }

    /// Awaits async work under a deadline, RECORDING A FAILURE instead of
    /// hanging when it never finishes.
    ///
    /// Every await in these tests eventually lands on the coordinator's
    /// per-server operation chain, and a chain whose head is parked on a
    /// continuation that is never resumed would otherwise wedge `xcodebuild`
    /// until the CI job's own multi-hour limit — one deadlocked test taking
    /// the whole suite's signal with it. A named failure in seconds is worth
    /// more than a job that never reports.
    private func awaitOrFail(
        _ description: String = "async work",
        file: StaticString = #filePath,
        line: UInt = #line,
        _ body: @escaping @MainActor () async -> Void
    ) async {
        let finished = expectation(description: description)
        Task { @MainActor in
            await body()
            finished.fulfill()
        }
        await fulfillment(of: [finished], timeout: Self.deadlineSeconds)
    }

    /// Generous enough that a loaded CI runner never flakes, short enough
    /// that a genuine deadlock reports in seconds.
    private static let deadlineSeconds: TimeInterval = 5

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
