import XCTest
@testable import ZeroDTETrader

// MARK: - Fakes

/// Records the device-global register/unregister calls the coordinator makes.
@MainActor
final class RegistryFake: RemoteNotificationRegistry {
    private(set) var registerCount = 0
    private(set) var unregisterCount = 0

    func registerForRemoteNotifications() { registerCount += 1 }
    func unregisterForRemoteNotifications() { unregisterCount += 1 }
}

/// Scriptable device-registration API: records every call, fails on demand,
/// and can hold the next call open until the test releases it — the seam the
/// staleness-race tests are built on.
@MainActor
final class DeviceAPIFake: DeviceRegistrationAPI {
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
final class AuthGate {
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

// MARK: - Shared fixture

/// Base for the push-lifecycle suites: fake APNs registry, scriptable API,
/// a fresh per-test UserDefaults suite, and deadline-bounded await helpers.
/// Split across files because one suite outgrew the file-length ceiling; the
/// fixtures are identical by construction, not by copy.
@MainActor
class PushLifecycleTestCase: XCTestCase {
    let serverA = "https://a.example"
    let serverB = "https://b.example"
    let tokenData = Data([0xAA, 0x11])
    let tokenHex = "aa11"

    private var suiteName: String!
    private var defaults: UserDefaults!
    var settings: SettingsStore!
    var registry: RegistryFake!
    var api: DeviceAPIFake!
    var coordinator: PushRegistrationCoordinator!

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

    func makeManager(
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
    func waitUntil(
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
    func awaitOrFail(
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
    static let deadlineSeconds: TimeInterval = 5
}
