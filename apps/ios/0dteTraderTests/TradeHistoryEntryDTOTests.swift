import Foundation
import XCTest
@testable import ZeroDTETrader

final class TradeHistoryEntryDTOTests: XCTestCase {
    func testDecodesCurrentInternalOrderIdentity() throws {
        let entry = try decodeEntry(extraField: "\"internalOrderId\":\"internal-uuid\",")

        XCTAssertEqual(entry.internalOrderId, "internal-uuid")
        XCTAssertEqual(entry.orderId, "broker-id")
    }

    func testFallsBackToBrokerIdentityForOlderServerPayload() throws {
        let entry = try decodeEntry(extraField: "")

        XCTAssertEqual(entry.internalOrderId, "broker-id")
        XCTAssertEqual(entry.orderId, "broker-id")
    }

    private func decodeEntry(extraField: String) throws -> TradeHistoryEntryDTO {
        let json = """
        {
          \(extraField)
          "orderId": "broker-id",
          "status": "filled",
          "contractSymbol": "SPY260805C00500000",
          "side": "buy",
          "quantity": 1,
          "orderType": "market",
          "filledPrice": 1.25,
          "timestamp": "2026-08-05T12:00:00.000Z",
          "realizedPnl": null
        }
        """
        return try JSONDecoder().decode(TradeHistoryEntryDTO.self, from: Data(json.utf8))
    }
}
