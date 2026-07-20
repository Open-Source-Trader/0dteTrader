import XCTest

/// Captures the README screenshots by driving the real app against the live
/// backend: accept the risk disclaimer, register a throwaway demo account,
/// wait for live chart data, and snapshot the key screens. Runs only via the
/// dedicated `0dteTraderScreenshots` scheme.
final class ScreenshotTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testCaptureReadmeScreenshots() throws {
        let app = XCUIApplication()
        app.launch()

        // First launch shows the risk disclaimer.
        let accept = app.buttons["I Understand and Accept"]
        if accept.waitForExistence(timeout: 15) {
            capture(name: "risk-disclaimer")
            accept.tap()
        }

        // Log in with a pre-created demo account (passed via TEST_RUNNER_ env
        // vars). Logging in avoids the iOS strong-password AutoFill sheet
        // that intercepts the register form's new-password fields.
        let environment = ProcessInfo.processInfo.environment
        guard let demoEmail = environment["DEMO_EMAIL"],
              let demoPassword = environment["DEMO_PASSWORD"]
        else {
            XCTFail("Set TEST_RUNNER_DEMO_EMAIL and TEST_RUNNER_DEMO_PASSWORD")
            return
        }
        // A persisted keychain session skips login entirely; only log in when
        // the login screen actually shows up.
        let email = app.textFields["Email"]
        if email.waitForExistence(timeout: 15) {
            capture(name: "login")
            email.tap()
            email.typeText(demoEmail)
            let password = app.secureTextFields["Password"]
            password.tap()
            password.typeText(demoPassword)
            app.buttons["login.submit"].tap()
        }

        // Trade screen: BUY appears once the panel is mounted.
        let buy = app.buttons["BUY"]
        XCTAssertTrue(buy.waitForExistence(timeout: 45), "Trade screen did not appear")

        // Dismiss the system "Save Password?" prompt if it appears.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let notNow = springboard.buttons["Not Now"]
        if notNow.waitForExistence(timeout: 8) {
            notNow.tap()
        }

        // Switch to SPX — index candles and the options structure both come
        // from Tradier server-side, so the demo account gets a full chart.
        let changeSymbol = app.buttons["Change symbol"]
        XCTAssertTrue(changeSymbol.waitForExistence(timeout: 10))
        changeSymbol.tap()
        sleep(2)
        capture(name: "symbol-search")
        let spxRow = app.buttons["SPX"].firstMatch
        XCTAssertTrue(spxRow.waitForExistence(timeout: 10), "SPX row not found")
        spxRow.tap()

        // Hourly interval so the chart shows the last sessions even when the
        // market is closed (1m windows are empty on weekends).
        let interval = app.buttons["Chart interval"]
        XCTAssertTrue(interval.waitForExistence(timeout: 10))
        interval.tap()
        let hourly = app.buttons["1H"]
        XCTAssertTrue(hourly.waitForExistence(timeout: 5), "Interval menu did not open")
        hourly.tap()

        // Give candles and the options-structure snapshot time to stream in.
        sleep(20)
        capture(name: "trade-screen")

        // Options structure details sheet (STRUCT capsule on the chart).
        let structButton = app.buttons.matching(
            NSPredicate(format: "label CONTAINS[c] 'options structure'")
        ).firstMatch
        if structButton.waitForExistence(timeout: 15) {
            structButton.tap()
            sleep(3)
            capture(name: "options-structure-details")
        }
    }

    private func capture(name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
