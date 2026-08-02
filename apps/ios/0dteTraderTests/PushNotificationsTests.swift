import XCTest
@testable import ZeroDTETrader

/// The pure halves of push registration: token encoding and the toggle's
/// desired-state transitions. The UIKit/UNUserNotificationCenter plumbing in
/// PushNotificationsManager stays a thin shell over these.
final class PushNotificationsTests: XCTestCase {
    // MARK: - Token hex encoding

    func testHexString_encodesLowercaseTwoDigitsPerByte() {
        let token = Data([0x00, 0xAB, 0xFF, 0x10, 0x7F])
        XCTAssertEqual(PushTokenEncoding.hexString(token), "00abff107f")
    }

    func testHexString_emptyTokenIsEmptyString() {
        XCTAssertEqual(PushTokenEncoding.hexString(Data()), "")
    }

    func testHexString_singleByteKeepsLeadingZero() {
        XCTAssertEqual(PushTokenEncoding.hexString(Data([0x05])), "05")
    }

    // MARK: - Toggle transitions

    func testToggleOn_requestsAuthorization() {
        XCTAssertEqual(
            PushRegistrationFlow.onToggle(enabled: true, uploadedToken: nil),
            .requestAuthorization
        )
        // Even with a token already uploaded: authorization can have been
        // revoked in Settings since, and re-asking is a silent no-op.
        XCTAssertEqual(
            PushRegistrationFlow.onToggle(enabled: true, uploadedToken: "abc123"),
            .requestAuthorization
        )
    }

    func testToggleOff_unregistersUploadedToken() {
        XCTAssertEqual(
            PushRegistrationFlow.onToggle(enabled: false, uploadedToken: "abc123"),
            .unregister(uploadedToken: "abc123")
        )
    }

    func testToggleOff_withoutUploadedToken_stillStopsApns() {
        XCTAssertEqual(
            PushRegistrationFlow.onToggle(enabled: false, uploadedToken: nil),
            .unregister(uploadedToken: nil)
        )
    }

    func testAuthorizationGranted_registersWithApns() {
        XCTAssertEqual(PushRegistrationFlow.onAuthorization(granted: true), .registerWithAPNs)
    }

    func testAuthorizationDenied_revertsTheToggle() {
        XCTAssertEqual(PushRegistrationFlow.onAuthorization(granted: false), .revertToggle)
    }

    // MARK: - Per-server token slots

    /// The retry handle is keyed per server: writing one server's slot must
    /// never disturb another's, and clearing removes only its own. This is
    /// what lets a server switch skip teardown entirely — the departed
    /// server's handle survives for its next sign-in to sweep.
    func testPushDeviceToken_slotsAreIsolatedPerServer() throws {
        let suiteName = "test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = SettingsStore(defaults: defaults)

        store.setPushDeviceToken("aa11", server: "https://a.example")
        store.setPushDeviceToken("bb22", server: "https://b.example")
        XCTAssertEqual(store.pushDeviceToken(server: "https://a.example"), "aa11")
        XCTAssertEqual(store.pushDeviceToken(server: "https://b.example"), "bb22")

        store.setPushDeviceToken(nil, server: "https://a.example")
        XCTAssertNil(store.pushDeviceToken(server: "https://a.example"))
        XCTAssertEqual(store.pushDeviceToken(server: "https://b.example"), "bb22")
    }
}
