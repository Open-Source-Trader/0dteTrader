import XCTest
@testable import ZeroDTETrader

final class LegalMarkdownTextTests: XCTestCase {
    func testRepositoryAndSupportLinksAreActionable() {
        let markdown = "[Source](https://github.com/Open-Source-Trader/0dteTrader) and "
            + "[support](https://github.com/Open-Source-Trader/0dteTrader/issues)"
        let links = legalMarkdownAttributedString(markdown).runs.compactMap(\.link)

        XCTAssertEqual(
            links.map(\.absoluteString),
            [
                "https://github.com/Open-Source-Trader/0dteTrader",
                "https://github.com/Open-Source-Trader/0dteTrader/issues"
            ]
        )
    }

    func testNonWebSchemesRemainTextAndAreNotActionable() {
        let markdown = "[script](javascript:alert) [phone](tel:+15551234567) "
            + "[custom](trader://place-order)"
        let rendered = legalMarkdownAttributedString(markdown)

        XCTAssertTrue(rendered.runs.compactMap(\.link).isEmpty)
        XCTAssertEqual(String(rendered.characters), "script phone custom")
    }
}
