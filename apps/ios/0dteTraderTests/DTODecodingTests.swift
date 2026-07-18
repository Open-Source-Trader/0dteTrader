import XCTest
@testable import ZeroDTETrader

/// Decodes the exact JSON shapes from docs/openapi.yaml (and the WS message
/// envelopes from docs/API-SPEC.md) to guard the app's wire contracts.
final class DTODecodingTests: XCTestCase {
    private let decoder = JSONDecoder()

    private func decode<T: Decodable>(_ type: T.Type, _ json: String, file: StaticString = #filePath, line: UInt = #line) throws -> T {
        guard let data = json.data(using: .utf8) else {
            XCTFail("invalid test JSON string", file: file, line: line)
            throw APIError.decoding
        }
        return try decoder.decode(T.self, from: data)
    }

    // MARK: - Auth & profile

    func testAuthTokens_decodes() throws {
        let tokens = try decode(AuthTokensDTO.self, """
        {"accessToken":"at-123","refreshToken":"rt-456","expiresIn":900}
        """)
        XCTAssertEqual(tokens.accessToken, "at-123")
        XCTAssertEqual(tokens.refreshToken, "rt-456")
        XCTAssertEqual(tokens.expiresIn, 900)
    }

    func testMe_decodes() throws {
        let me = try decode(MeDTO.self, """
        {"id":"u-1","email":"dev@example.com","tradingDisabled":false,"webullConfigured":true}
        """)
        XCTAssertEqual(me.id, "u-1")
        XCTAssertEqual(me.email, "dev@example.com")
        XCTAssertFalse(me.tradingDisabled)
        XCTAssertTrue(me.webullConfigured)
    }

    func testAPIErrorEnvelope_decodes() throws {
        let envelope = try decode(APIErrorEnvelope.self, """
        {"error":{"code":"TRADING_DISABLED","message":"Trading is disabled for this user"}}
        """)
        XCTAssertEqual(envelope.error.code, "TRADING_DISABLED")
        XCTAssertEqual(envelope.error.message, "Trading is disabled for this user")
    }

    // MARK: - Market data

    func testQuote_decodes() throws {
        let dto = try decode(QuoteDTO.self, """
        {"symbol":"SPY","bid":501.10,"ask":501.14,"last":501.12,"bidSize":12,"askSize":9,"volume":1234567,"timestamp":"2026-07-17T14:30:00Z"}
        """)
        XCTAssertEqual(dto.symbol, "SPY")
        XCTAssertEqual(dto.bid, 501.10, accuracy: 1e-9)
        XCTAssertEqual(dto.ask, 501.14, accuracy: 1e-9)
        XCTAssertEqual(dto.volume, 1_234_567)

        let quote = Quote(dto: dto)
        XCTAssertEqual(quote.timestamp.timeIntervalSince1970, 1_784_298_600, accuracy: 60)
    }

    func testQuote_fractionalSecondTimestamp_parses() throws {
        let dto = try decode(QuoteDTO.self, """
        {"symbol":"SPY","bid":1,"ask":2,"last":1.5,"bidSize":1,"askSize":1,"volume":1,"timestamp":"2026-07-17T14:30:00.123Z"}
        """)
        XCTAssertGreaterThan(Quote(dto: dto).timestamp.timeIntervalSince1970, 0)
    }

    func testCandle_decodes() throws {
        let dto = try decode(CandleDTO.self, """
        {"time":"2026-07-17T14:30:00Z","open":501.0,"high":502.5,"low":500.5,"close":502.0,"volume":98765}
        """)
        XCTAssertEqual(dto.open, 501.0, accuracy: 1e-9)
        XCTAssertEqual(dto.high, 502.5, accuracy: 1e-9)
        XCTAssertEqual(dto.volume, 98_765)
    }

    func testOptionsChain_decodes() throws {
        let dto = try decode(OptionsChainDTO.self, """
        {
          "underlying": "SPY",
          "underlyingPrice": 502.13,
          "expirations": ["2026-07-17", "2026-07-20"],
          "contracts": [
            {"symbol":"SPY260717C00503000","underlying":"SPY","expiration":"2026-07-17","strike":503,"optionType":"call","bid":1.20,"ask":1.28,"last":1.24},
            {"symbol":"SPY260717P00502000","underlying":"SPY","expiration":"2026-07-17","strike":502,"optionType":"put","bid":1.10,"ask":1.18,"last":1.14}
          ]
        }
        """)
        XCTAssertEqual(dto.underlying, "SPY")
        XCTAssertEqual(dto.underlyingPrice, 502.13, accuracy: 1e-9)
        XCTAssertEqual(dto.expirations, ["2026-07-17", "2026-07-20"])
        XCTAssertEqual(dto.contracts.count, 2)
        XCTAssertEqual(dto.contracts[0].strike, 503, accuracy: 1e-9)
        XCTAssertEqual(dto.contracts[0].optionType, "call")

        let chain = OptionsChain(dto: dto)
        XCTAssertEqual(chain.contracts[1].optionType, .put)
    }

    func testFuturesContract_decodes() throws {
        let dto = try decode(FuturesContractDTO.self, """
        {"symbol":"MESU26","root":"MES","expiration":"2026-09-18","frontMonth":true,"bid":6010.25,"ask":6010.75,"last":6010.50}
        """)
        XCTAssertEqual(dto.root, "MES")
        XCTAssertTrue(dto.frontMonth)
    }

    // MARK: - Trading

    func testOrderPreview_decodes() throws {
        let dto = try decode(OrderPreviewDTO.self, """
        {"resolved":{"contractSymbol":"SPY260717C00503000","price":1.24,"estBuyingPower":124.0},"warnings":["Wide spread"]}
        """)
        XCTAssertEqual(dto.resolved.contractSymbol, "SPY260717C00503000")
        XCTAssertEqual(dto.resolved.price, 1.24, accuracy: 1e-9)
        XCTAssertEqual(dto.warnings, ["Wide spread"])
    }

    func testOrderResult_decodesWithOptionalPrices() throws {
        let dto = try decode(OrderResultDTO.self, """
        {"orderId":"o-1","status":"filled","contractSymbol":"SPY260717C00503000","side":"buy","quantity":2,"orderType":"mid","limitPrice":1.24,"filledPrice":1.24,"timestamp":"2026-07-17T14:31:00Z"}
        """)
        XCTAssertEqual(dto.limitPrice, 1.24)
        XCTAssertEqual(dto.filledPrice, 1.24)

        let result = OrderResult(dto: dto)
        XCTAssertEqual(result.status, .filled)
        XCTAssertEqual(result.side, .buy)
        XCTAssertEqual(result.quantity, 2)
    }

    func testOrderResult_decodesWithoutOptionalPrices() throws {
        let dto = try decode(OrderResultDTO.self, """
        {"orderId":"o-2","status":"submitted","contractSymbol":"MESU26","side":"sell","quantity":1,"orderType":"market","timestamp":"2026-07-17T14:31:00Z"}
        """)
        XCTAssertNil(dto.limitPrice)
        XCTAssertNil(dto.filledPrice)
        XCTAssertEqual(OrderResult(dto: dto).status, .submitted)
    }

    func testPosition_decodesNegativeQuantity() throws {
        let dto = try decode(PositionDTO.self, """
        {"symbol":"MESU26","assetClass":"future","quantity":-2,"avgPrice":6010.5,"markPrice":6012.0,"unrealizedPnl":-15.0,"multiplier":5}
        """)
        let position = try XCTUnwrap(Position(dto: dto))
        XCTAssertEqual(position.quantity, -2)
        XCTAssertEqual(position.assetClass, .future)
        XCTAssertEqual(position.unrealizedPnl, -15.0, accuracy: 1e-9)
    }

    /// An unknown asset class must drop the position, not fall back to .option
    /// (which would route a flatten through the options path).
    func testPosition_unknownAssetClass_isDropped() throws {
        let dto = try decode(PositionDTO.self, """
        {"symbol":"AAPL","assetClass":"equity","quantity":10,"avgPrice":210.0,"markPrice":211.0,"unrealizedPnl":10.0,"multiplier":1}
        """)
        XCTAssertNil(Position(dto: dto))
    }

    /// An unknown option type must drop the contract, not fall back to .call.
    func testOptionsChain_unknownOptionType_contractIsDropped() throws {
        let dto = try decode(OptionsChainDTO.self, """
        {
          "underlying": "SPY",
          "underlyingPrice": 502.13,
          "expirations": ["2026-07-17"],
          "contracts": [
            {"symbol":"SPY260717C00503000","underlying":"SPY","expiration":"2026-07-17","strike":503,"optionType":"call","bid":1.20,"ask":1.28,"last":1.24},
            {"symbol":"SPY260717X00502000","underlying":"SPY","expiration":"2026-07-17","strike":502,"optionType":"straddle","bid":1.10,"ask":1.18,"last":1.14}
          ]
        }
        """)
        let chain = OptionsChain(dto: dto)
        XCTAssertEqual(chain.contracts.count, 1)
        XCTAssertEqual(chain.contracts[0].optionType, .call)
    }

    func testOrderRequest_encodesExactContractShape() throws {
        let request = OrderRequestDTO(
            underlying: "SPY",
            assetClass: "option",
            side: "buy",
            quantity: 2,
            orderType: "mid",
            selection: OrderSelectionDTO(
                mode: "auto_otm",
                optionType: "call",
                expiration: "2026-07-17",
                strike: nil,
                contractSymbol: nil
            )
        )
        let data = try JSONEncoder().encode(request)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["underlying"] as? String, "SPY")
        XCTAssertEqual(object["assetClass"] as? String, "option")
        XCTAssertEqual(object["side"] as? String, "buy")
        XCTAssertEqual(object["quantity"] as? Int, 2)
        XCTAssertEqual(object["orderType"] as? String, "mid")

        let selection = try XCTUnwrap(object["selection"] as? [String: Any])
        XCTAssertEqual(selection["mode"] as? String, "auto_otm")
        XCTAssertEqual(selection["optionType"] as? String, "call")
        XCTAssertEqual(selection["expiration"] as? String, "2026-07-17")
        // Nil fields must be omitted, not null (server validates explicit-only fields).
        XCTAssertNil(selection["strike"])
        XCTAssertNil(selection["contractSymbol"])
    }

    func testOrderRequest_explicitFuture_encodesContractSymbol() throws {
        let request = OrderRequestDTO(
            underlying: "MES",
            assetClass: "future",
            side: "sell",
            quantity: 1,
            orderType: "market",
            selection: OrderSelectionDTO(
                mode: "explicit",
                optionType: nil,
                expiration: nil,
                strike: nil,
                contractSymbol: "MESU26"
            )
        )
        let data = try JSONEncoder().encode(request)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let selection = try XCTUnwrap(object["selection"] as? [String: Any])
        XCTAssertEqual(selection["contractSymbol"] as? String, "MESU26")
        XCTAssertNil(selection["optionType"])
        XCTAssertNil(selection["strike"])
    }

    // MARK: - WebSocket messages

    func testSocketQuoteMessage_decodes() throws {
        let envelope = try decode(SocketEnvelope.self, """
        {"type":"quote","data":{"symbol":"SPY","bid":1,"ask":2,"last":1.5,"bidSize":1,"askSize":1,"volume":1,"timestamp":"2026-07-17T14:30:00Z"}}
        """)
        XCTAssertEqual(envelope.type, "quote")

        let message = try decode(SocketQuoteMessage.self, """
        {"type":"quote","data":{"symbol":"SPY","bid":1,"ask":2,"last":1.5,"bidSize":1,"askSize":1,"volume":1,"timestamp":"2026-07-17T14:30:00Z"}}
        """)
        XCTAssertEqual(message.data.symbol, "SPY")
    }

    func testSocketOrderUpdateMessage_decodes() throws {
        let message = try decode(SocketOrderUpdateMessage.self, """
        {"type":"orderUpdate","data":{"orderId":"o-9","status":"filled","contractSymbol":"SPY260717C00503000","side":"buy","quantity":1,"orderType":"mid","limitPrice":1.24,"filledPrice":1.24,"timestamp":"2026-07-17T14:32:00Z"}}
        """)
        XCTAssertEqual(message.data.orderId, "o-9")
        XCTAssertEqual(message.data.status, "filled")
    }

    func testSocketErrorMessage_decodes() throws {
        let message = try decode(SocketErrorMessage.self, """
        {"type":"error","error":{"code":"UNAUTHORIZED","message":"bad token"}}
        """)
        XCTAssertEqual(message.error.code, "UNAUTHORIZED")
    }

    func testSocketSubscribeMessage_encodes() throws {
        let data = try JSONEncoder().encode(SocketSubscribeMessage(type: "subscribe", symbols: ["SPY"]))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, "subscribe")
        XCTAssertEqual(object["symbols"] as? [String], ["SPY"])
    }
}
