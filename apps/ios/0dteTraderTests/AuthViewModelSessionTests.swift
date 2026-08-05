import XCTest
@testable import ZeroDTETrader

/// The forced-logout observer is filtered to the container's OWN session
/// store: a departed container's in-flight refresh can 401 after a server
/// switch, and an unfiltered observer would log the CURRENT server's
/// session out with it.
@MainActor
final class AuthViewModelSessionTests: XCTestCase {
    private func makeViewModel(tag: String) -> (AuthViewModel, SessionStore, SessionStore) {
        let baseURL = URL(string: "http://localhost:0")!
        let mine = SessionStore(
            keychainStore: KeychainStore(service: "test.auth.\(tag).mine"),
            baseURL: baseURL
        )
        let departed = SessionStore(
            keychainStore: KeychainStore(service: "test.auth.\(tag).departed"),
            baseURL: baseURL
        )
        let viewModel = AuthViewModel(
            apiClient: APIClient(baseURL: baseURL, sessionStore: mine),
            sessionStore: mine,
            settingsStore: SettingsStore(),
            socket: QuoteSocketClient(streamURL: URL(string: "ws://localhost:0")!) { "" }
        )
        return (viewModel, mine, departed)
    }

    /// Spins the main actor until `condition` holds or a deadline passes.
    private func waitUntil(_ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(5)
        while !condition(), Date() <= deadline {
            await Task.yield()
        }
    }

    func testExpiryFromOwnSessionStore_forcesLogout() async {
        let (viewModel, mine, _) = makeViewModel(tag: "own")

        NotificationCenter.default.post(
            name: .sessionDidBecomeUnauthenticated,
            object: mine,
            userInfo: [SessionStore.serverKeyUserInfoKey: "http://localhost:0"]
        )

        await waitUntil { viewModel.state == .unauthenticated }
        XCTAssertEqual(viewModel.state, .unauthenticated)
    }

    func testExpiryFromADepartedSessionStore_isIgnored() async {
        let (viewModel, _, departed) = makeViewModel(tag: "departed")

        NotificationCenter.default.post(
            name: .sessionDidBecomeUnauthenticated,
            object: departed,
            userInfo: [SessionStore.serverKeyUserInfoKey: "http://localhost:0"]
        )
        // Let any (wrong) observer hop land before asserting nothing moved.
        for _ in 0..<20 { await Task.yield() }

        XCTAssertEqual(viewModel.state, .checking)
    }
}
