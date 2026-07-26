import XCTest
@testable import ZeroDTETrader

final class ServerConfigStoreTests: XCTestCase {
    private let defaultBaseURL = URL(string: "http://localhost:3000")!
    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        suiteName = "ServerConfigStoreTests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
    }

    private func makeStore() -> ServerConfigStore {
        ServerConfigStore(defaults: defaults, defaultBaseURL: defaultBaseURL)
    }

    // MARK: - load()

    func testLoadFallsBackToBuildTimeDefaultWhenNothingStored() {
        XCTAssertEqual(makeStore().load(), defaultBaseURL)
        XCTAssertEqual(makeStore().baseURL, defaultBaseURL)
    }

    func testLoadIgnoresInvalidStoredValue() {
        defaults.set("not a url", forKey: ServerConfigStore.storageKey)
        XCTAssertEqual(makeStore().load(), defaultBaseURL)

        defaults.set("https://stale.example/some/path", forKey: ServerConfigStore.storageKey)
        XCTAssertEqual(makeStore().load(), defaultBaseURL)
    }

    // MARK: - save()

    func testSavePersistsValidURLAndRoundTrips() throws {
        let store = makeStore()
        let saved = try store.save("https://my-api.up.railway.app")

        XCTAssertEqual(saved, URL(string: "https://my-api.up.railway.app"))
        XCTAssertEqual(store.baseURL, saved)
        // A fresh store sees the persisted override.
        XCTAssertEqual(makeStore().load(), saved)
    }

    func testSaveTrimsWhitespace() throws {
        let saved = try makeStore().save("  https://my-api.up.railway.app \n")
        XCTAssertEqual(saved.absoluteString, "https://my-api.up.railway.app")
    }

    func testSaveStripsTrailingSlashes() throws {
        let saved = try makeStore().save("https://my-api.up.railway.app///")
        XCTAssertEqual(saved.absoluteString, "https://my-api.up.railway.app")
    }

    func testSaveStripsPastedV1Suffix() throws {
        let saved = try makeStore().save("https://my-api.up.railway.app/v1")
        XCTAssertEqual(saved.absoluteString, "https://my-api.up.railway.app")
    }

    func testSaveStripsPastedV1SuffixWithTrailingSlash() throws {
        let saved = try makeStore().save("https://my-api.up.railway.app/v1/")
        XCTAssertEqual(saved.absoluteString, "https://my-api.up.railway.app")
    }

    func testSaveStripsPastedV1HealthSuffix() throws {
        let saved = try makeStore().save("https://my-api.up.railway.app/v1/health")
        XCTAssertEqual(saved.absoluteString, "https://my-api.up.railway.app")
    }

    func testSaveStripsPastedV1SuffixCaseInsensitively() throws {
        let saved = try makeStore().save("https://my-api.up.railway.app/V1/HEALTH")
        XCTAssertEqual(saved.absoluteString, "https://my-api.up.railway.app")
    }

    func testSaveDropsExplicitDefaultPorts() throws {
        XCTAssertEqual(
            try makeStore().save("https://my-api.up.railway.app:443").absoluteString,
            "https://my-api.up.railway.app"
        )
        XCTAssertEqual(
            try makeStore().save("http://my-api.up.railway.app:80").absoluteString,
            "http://my-api.up.railway.app"
        )
    }

    func testSaveKeepsExplicitPort() throws {
        let saved = try makeStore().save("http://192.168.1.20:3000/")
        XCTAssertEqual(saved.absoluteString, "http://192.168.1.20:3000")
    }

    func testSaveRejectsURLWithPath() {
        XCTAssertThrowsError(try makeStore().save("https://my-api.up.railway.app/api"))
        XCTAssertThrowsError(try makeStore().save("https://my-api.up.railway.app/api/v1"))
    }

    func testSaveRejectsURLWithQueryOrFragment() {
        XCTAssertThrowsError(try makeStore().save("https://my-api.up.railway.app?x=1"))
        XCTAssertThrowsError(try makeStore().save("https://my-api.up.railway.app#section"))
    }

    func testSaveRejectsEmbeddedCredentials() {
        XCTAssertThrowsError(try makeStore().save("https://user:pass@my-api.up.railway.app"))
        XCTAssertThrowsError(try makeStore().save("https://user@my-api.up.railway.app"))
    }

    func testSaveRejectsJunk() {
        XCTAssertThrowsError(try makeStore().save("not a url"))
        XCTAssertThrowsError(try makeStore().save(""))
        XCTAssertThrowsError(try makeStore().save("https://"))
    }

    func testSaveRejectsNonHTTPSchemes() {
        XCTAssertThrowsError(try makeStore().save("ftp://my-api.up.railway.app"))
        XCTAssertThrowsError(try makeStore().save("ws://my-api.up.railway.app"))
    }

    func testSaveErrorIsUserShowable() {
        XCTAssertThrowsError(try makeStore().save("junk")) { error in
            XCTAssertFalse(error.localizedDescription.isEmpty)
            XCTAssertTrue(error.localizedDescription.contains("http"))
        }
    }

    // MARK: - reset()

    func testResetRemovesOverride() throws {
        let store = makeStore()
        try store.save("https://my-api.up.railway.app")
        store.reset()

        XCTAssertNil(defaults.string(forKey: ServerConfigStore.storageKey))
        XCTAssertEqual(store.baseURL, defaultBaseURL)
        XCTAssertEqual(makeStore().load(), defaultBaseURL)
    }

    // MARK: - Stream URL derivation

    func testStreamURLDerivationForHTTP() {
        let stream = ServerConfigStore.streamURL(for: URL(string: "http://localhost:3000")!)
        XCTAssertEqual(stream.absoluteString, "ws://localhost:3000/v1/stream")
    }

    func testStreamURLDerivationForHTTPS() {
        let stream = ServerConfigStore.streamURL(for: URL(string: "https://my-api.up.railway.app")!)
        XCTAssertEqual(stream.absoluteString, "wss://my-api.up.railway.app/v1/stream")
    }

    // MARK: - TLS pinning scope

    /// Pins must only ever apply to the built-in default host — a self-hoster's
    /// server must never be evaluated against our pins (#59).
    func testPinsApplyOnlyToDefaultHost() {
        let pins = ["fakehash="]
        XCTAssertEqual(
            AppConfig.pinnedPublicKeyHashes(
                for: URL(string: "https://api.0dtetrader.example")!,
                defaultHost: "api.0dtetrader.example",
                pins: pins
            ),
            pins
        )
        XCTAssertEqual(
            AppConfig.pinnedPublicKeyHashes(
                for: URL(string: "https://my-api.up.railway.app")!,
                defaultHost: "api.0dtetrader.example",
                pins: pins
            ),
            []
        )
    }

    // MARK: - Refresh-token scoping

    /// The Keychain refresh token is scoped per server origin, so a token
    /// issued by one server is never sent to another after a server change.
    func testRefreshTokenAccountIsScopedByServerOrigin() {
        let railway = KeychainStore.refreshTokenAccount(for: URL(string: "https://my-api.up.railway.app")!)
        let localhost = KeychainStore.refreshTokenAccount(for: URL(string: "http://localhost:3000")!)

        XCTAssertNotEqual(railway, localhost)
        // Stable for the same origin.
        XCTAssertEqual(
            railway,
            KeychainStore.refreshTokenAccount(for: URL(string: "https://my-api.up.railway.app")!)
        )
        // The port is part of the origin.
        XCTAssertNotEqual(
            localhost,
            KeychainStore.refreshTokenAccount(for: URL(string: "http://localhost:4000")!)
        )
        // The scheme alone separates accounts: an http:// typo for an https
        // server must never see the https session's token.
        XCTAssertNotEqual(
            KeychainStore.refreshTokenAccount(for: URL(string: "https://my-api.up.railway.app")!),
            KeychainStore.refreshTokenAccount(for: URL(string: "http://my-api.up.railway.app")!)
        )
    }
}
