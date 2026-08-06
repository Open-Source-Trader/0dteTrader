import XCTest
@testable import ZeroDTETrader

final class IVAlertBannerTests: XCTestCase {
    func testAccessibilityLabelUsesDisplayedPercentagesAndIncludesTime() {
        let banner = IVAlertBanner(
            alert: IVAlertDTO(
                symbol: .SPX,
                direction: .expansion,
                currentIv: 0.24,
                baselineIv: 0.20,
                zScore: 3.1,
                timestamp: "2026-08-05T14:30:00Z"
            ),
            onDismiss: {}
        )

        XCTAssertTrue(banner.accessibilityLabelText.contains("24.0 percent"))
        XCTAssertTrue(banner.accessibilityLabelText.contains("20.0 percent"))
        XCTAssertTrue(banner.accessibilityLabelText.contains("at "))
    }
}

@MainActor
final class ProfileIVAlertSaveRecoveryTests: XCTestCase {
    func testRejectedSavePreservesServerErrorAndUnlocksEditor() async throws {
        let (viewModel, socket) = makeSystem(saveTimeout: .milliseconds(20))
        await seedConnectedConfiguration(socket)

        viewModel.updateIVAlertConfiguration(configuration(lookbackMinutes: 35))
        XCTAssertTrue(viewModel.isIVAlertConfigurationBusy)

        await socket.processPayloadForTesting(Data("""
        {"type":"error","error":{"code":"IV_ALERT_CONFIGURATION_INVALID","message":"Database unavailable."}}
        """.utf8))
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(
            socket.lastError,
            SocketClientError(code: "IV_ALERT_CONFIGURATION_INVALID", message: "Database unavailable.")
        )
        XCTAssertFalse(viewModel.isIVAlertConfigurationBusy)
        XCTAssertEqual(viewModel.ivAlertConfigurationMessage, "Database unavailable.")
    }

    func testDisconnectWhileSavingUnlocksEditor() async throws {
        let (viewModel, socket) = makeSystem(saveTimeout: .milliseconds(20))
        await seedConnectedConfiguration(socket)

        viewModel.updateIVAlertConfiguration(configuration(lookbackMinutes: 35))
        XCTAssertTrue(viewModel.isIVAlertConfigurationBusy)

        socket.disconnect()
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertFalse(viewModel.isIVAlertConfigurationBusy)
        XCTAssertEqual(
            viewModel.ivAlertConfigurationMessage,
            "Connection lost before IV alert settings were saved. Try again."
        )
    }

    func testSaveTimeoutUnlocksEditor() async throws {
        let (viewModel, socket) = makeSystem(saveTimeout: .milliseconds(20))
        await seedConnectedConfiguration(socket)

        viewModel.updateIVAlertConfiguration(configuration(lookbackMinutes: 35))
        XCTAssertTrue(viewModel.isIVAlertConfigurationBusy)

        try await Task.sleep(for: .milliseconds(50))

        XCTAssertFalse(viewModel.isIVAlertConfigurationBusy)
        XCTAssertEqual(
            viewModel.ivAlertConfigurationMessage,
            "IV alert settings save timed out. Check your connection and try again."
        )
    }

    func testSuccessfulAcknowledgmentCancelsTimeout() async throws {
        let (viewModel, socket) = makeSystem(saveTimeout: .milliseconds(20))
        await seedConnectedConfiguration(socket)

        viewModel.updateIVAlertConfiguration(configuration(lookbackMinutes: 35))
        await socket.processPayloadForTesting(configurationPayload(lookbackMinutes: 35))
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertFalse(viewModel.isIVAlertConfigurationBusy)
        XCTAssertEqual(viewModel.ivAlertConfigurationMessage, "IV alert settings saved.")
    }

    func testMismatchedConfigurationDoesNotAcknowledgePendingSave() async throws {
        let (viewModel, socket) = makeSystem(saveTimeout: .milliseconds(20))
        await seedConnectedConfiguration(socket)

        viewModel.updateIVAlertConfiguration(configuration(lookbackMinutes: 35))
        await socket.processPayloadForTesting(configurationPayload(lookbackMinutes: 40))

        XCTAssertTrue(viewModel.isIVAlertConfigurationBusy)
        XCTAssertEqual(viewModel.ivAlertConfigurationMessage, "Saving IV alert settings…")

        try await Task.sleep(for: .milliseconds(50))
        XCTAssertFalse(viewModel.isIVAlertConfigurationBusy)
        XCTAssertEqual(
            viewModel.ivAlertConfigurationMessage,
            "IV alert settings save timed out. Check your connection and try again."
        )
    }

    private func makeSystem(
        saveTimeout: Duration = .seconds(15)
    ) -> (ProfileViewModel, QuoteSocketClient) {
        let identifier = UUID().uuidString
        let baseURL = URL(string: "https://profile-iv-save.test")!
        let sessionStore = SessionStore(
            keychainStore: KeychainStore(service: "ProfileIVAlertSaveRecoveryTests.\(identifier)"),
            baseURL: baseURL
        )
        let socket = QuoteSocketClient(
            streamURL: URL(string: "wss://profile-iv-save.test/v1/stream")!,
            tokenProvider: { "token" }
        )
        let defaults = UserDefaults(suiteName: "ProfileIVAlertSaveRecoveryTests.\(identifier)")!
        let viewModel = ProfileViewModel(
            apiClient: APIClient(baseURL: baseURL, sessionStore: sessionStore),
            settingsStore: SettingsStore(defaults: defaults),
            quoteSocket: socket,
            ivAlertSaveTimeout: saveTimeout,
            onLogout: {}
        )
        return (viewModel, socket)
    }

    private func seedConnectedConfiguration(_ socket: QuoteSocketClient) async {
        await socket.processPayloadForTesting(configurationPayload(lookbackMinutes: 30))
        socket.setConnectionStateForTesting(.connected)
    }

    private func configuration(lookbackMinutes: Int) -> IVAlertConfigurationDTO {
        IVAlertConfigurationDTO(
            enabled: true,
            symbols: [.SPX],
            lookbackMinutes: lookbackMinutes,
            thresholdK: 3,
            consecutiveBreaches: 2,
            warmupMinutes: 15,
            warmupSamples: 10,
            cooldownMinutes: 15
        )
    }

    private func configurationPayload(lookbackMinutes: Int) -> Data {
        Data("""
        {
          "type": "ivAlertConfiguration",
          "data": {
            "enabled": true,
            "symbols": ["SPX"],
            "lookbackMinutes": \(lookbackMinutes),
            "thresholdK": 3,
            "consecutiveBreaches": 2,
            "warmupMinutes": 15,
            "warmupSamples": 10,
            "cooldownMinutes": 15,
            "schemaVersion": 1,
            "updatedAt": "2026-08-05T14:30:00Z"
          }
        }
        """.utf8)
    }
}
