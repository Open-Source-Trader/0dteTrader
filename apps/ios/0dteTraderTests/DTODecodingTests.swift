// swiftlint:disable line_length
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
        XCTAssertNil(me.webullAccountId)
    }

    func testMe_decodesDiscoveredAccountId() throws {
        let me = try decode(MeDTO.self, """
        {"id":"u-1","email":"dev@example.com","tradingDisabled":false,"webullConfigured":true,"webullAccountId":"ACC-9"}
        """)
        XCTAssertEqual(me.webullAccountId, "ACC-9")
    }

    func testMe_decodesTradingMode() throws {
        let me = try decode(MeDTO.self, """
        {"id":"u-1","email":"dev@example.com","tradingDisabled":false,"webullConfigured":true,"tradingMode":"live"}
        """)
        XCTAssertEqual(me.tradingMode, .live)
    }

    func testMe_tradingModeNilOnOlderServers() throws {
        let me = try decode(MeDTO.self, """
        {"id":"u-1","email":"dev@example.com","tradingDisabled":false,"webullConfigured":true}
        """)
        XCTAssertNil(me.tradingMode)
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
        {"orderId":"o-2","status":"submitted","contractSymbol":"SPY260717C00503000","side":"sell","quantity":1,"orderType":"market","timestamp":"2026-07-17T14:31:00Z"}
        """)
        XCTAssertNil(dto.limitPrice)
        XCTAssertNil(dto.filledPrice)
        XCTAssertEqual(OrderResult(dto: dto).status, .submitted)
    }

    func testPosition_decodesNegativeQuantity() throws {
        let dto = try decode(PositionDTO.self, """
        {"symbol":"SPY260717C00503000","assetClass":"option","quantity":-2,"avgPrice":1.5,"markPrice":1.6,"unrealizedPnl":-20.0,"multiplier":100}
        """)
        let position = try XCTUnwrap(Position(dto: dto))
        XCTAssertEqual(position.quantity, -2)
        XCTAssertEqual(position.assetClass, .option)
        XCTAssertEqual(position.unrealizedPnl, -20.0, accuracy: 1e-9)
        XCTAssertNil(position.openedAt)
    }

    func testPosition_decodesOpenedAt() throws {
        let dto = try decode(PositionDTO.self, """
        {"symbol":"SPY260717C00503000","assetClass":"option","quantity":1,"avgPrice":1.5,"markPrice":1.6,"unrealizedPnl":10.0,"multiplier":100,"underlyingEntryPrice":502.4,"openedAt":"2026-07-17T14:30:00.000Z"}
        """)
        let position = try XCTUnwrap(Position(dto: dto))
        XCTAssertEqual(position.underlyingEntryPrice, 502.4)
        XCTAssertEqual(position.openedAt, DateParsing.dateTime("2026-07-17T14:30:00.000Z"))
        XCTAssertNotNil(position.openedAt)
        XCTAssertNil(position.underlyingEntryEstimate)
    }

    /// While the backend cannot observe the underlying at fill time it sends
    /// only the placement-time estimate; the authoritative field stays absent
    /// and each decodes independently of the other.
    func testPosition_decodesUnderlyingEntryEstimate() throws {
        let dto = try decode(PositionDTO.self, """
        {"symbol":"SPY260717C00503000","assetClass":"option","quantity":1,"avgPrice":1.5,"markPrice":1.6,"unrealizedPnl":10.0,"multiplier":100,"underlyingEntryEstimate":501.9}
        """)
        let position = try XCTUnwrap(Position(dto: dto))
        XCTAssertNil(position.underlyingEntryPrice)
        XCTAssertEqual(position.underlyingEntryEstimate, 501.9)
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
                strike: nil
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
        // Classic is fixed to exactly one strike OTM and exposes no offset.
        XCTAssertNil(selection["otmOffset"])
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

    func testSocketL2Snapshot_decodesExactContract() throws {
        let message = try decode(SocketL2SnapshotMessage.self, """
        {"type":"l2Snapshot","data":{"snapshot":{"symbol":"SPY","provider":"webull","capability":"nasdaq_totalview_non_display","freshness":"fresh","timestamp":"2026-08-05T14:30:00Z","receivedAt":"2026-08-05T14:30:00.100Z","depth":2,"bids":[{"price":501.11,"size":12},{"price":501.10,"size":20}],"asks":[{"price":501.12,"size":8},{"price":501.13,"size":18}]},"indicators":{"spreadAbs":0.01,"spreadBps":0.2,"spreadPercentile":0.4,"topBookImbalance":0.2,"tickPressure":0.1,"depthImbalance":0.15,"cumulativePressure":0.05,"touchDepletion":null}}}
        """)
        XCTAssertEqual(message.data.snapshot.depth, 2)
        XCTAssertEqual(message.data.snapshot.receivedAt, "2026-08-05T14:30:00.100Z")
        XCTAssertEqual(message.data.indicators.spreadAbs, 0.01)
        XCTAssertNil(message.data.indicators.touchDepletion)
    }

    func testSocketL2Snapshot_requiresCanonicalReceiptTimestamp() {
        XCTAssertThrowsError(try decode(SocketL2SnapshotMessage.self, """
        {"type":"l2Snapshot","data":{"snapshot":{"symbol":"SPY","provider":"webull","capability":"nasdaq_totalview_non_display","freshness":"fresh","timestamp":"2026-08-05T14:30:00Z","depth":1,"bids":[{"price":501.11,"size":12}],"asks":[{"price":501.12,"size":8}]},"indicators":{"spreadAbs":0.01,"spreadBps":0.2,"spreadPercentile":50,"topBookImbalance":0.2,"tickPressure":0.1,"depthImbalance":0.15,"cumulativePressure":0.05,"touchDepletion":null}}}
        """))
    }

    func testSocketL2Status_requiresFreshAvailableState() throws {
        let available = try decode(SocketL2StatusMessage.self, """
        {"type":"l2Status","data":{"availability":"available","symbol":"SPY","provider":"webull","capability":"nasdaq_totalview_non_display","freshness":"fresh"}}
        """)
        XCTAssertTrue(available.data.isAvailable)
        XCTAssertThrowsError(try decode(SocketL2StatusMessage.self, """
        {"type":"l2Status","data":{"availability":"available","symbol":"SPY","provider":"webull","capability":"nasdaq_totalview_non_display","freshness":"stale"}}
        """))
    }

    func testSocketIVAlertAndConfiguration_decodeExactContract() throws {
        let alert = try decode(SocketIVAlertMessage.self, """
        {"type":"ivAlert","data":{"symbol":"SPX","direction":"expansion","currentIv":0.24,"baselineIv":0.20,"zScore":3.1,"timestamp":"2026-08-05T14:30:00Z"}}
        """)
        XCTAssertEqual(alert.data.symbol, .SPX)
        XCTAssertEqual(alert.data.zScore, 3.1)

        let state = try decode(SocketIVAlertConfigurationMessage.self, """
        {"type":"ivAlertConfiguration","data":{"enabled":true,"symbols":["SPX","NDX"],"lookbackMinutes":30,"thresholdK":3,"consecutiveBreaches":2,"warmupMinutes":15,"warmupSamples":10,"cooldownMinutes":15,"schemaVersion":1,"updatedAt":"2026-08-05T14:30:00Z"}}
        """)
        XCTAssertEqual(state.data.schemaVersion, 1)
        XCTAssertEqual(state.data.symbols, [.SPX, .NDX])
    }

    func testDisconnectClearsUserScopedIVState() async {
        let client = await MainActor.run {
            QuoteSocketClient(
                streamURL: URL(string: "wss://iv.test/v1/stream")!,
                tokenProvider: { "token" }
            )
        }
        await client.processPayloadForTesting(Data("""
        {"type":"ivAlert","data":{"symbol":"SPX","direction":"expansion","currentIv":0.24,"baselineIv":0.20,"zScore":3.1,"timestamp":"2026-08-05T14:30:00Z"}}
        """.utf8))
        await client.processPayloadForTesting(Data("""
        {"type":"ivAlertConfiguration","data":{"enabled":true,"symbols":["SPX"],"lookbackMinutes":30,"thresholdK":3,"consecutiveBreaches":2,"warmupMinutes":15,"warmupSamples":10,"cooldownMinutes":15,"schemaVersion":1,"updatedAt":"2026-08-05T14:30:00Z"}}
        """.utf8))

        await MainActor.run {
            XCTAssertNotNil(client.latestIVAlert)
            XCTAssertNotNil(client.ivAlertConfiguration)
            client.disconnect()
            XCTAssertNil(client.latestIVAlert)
            XCTAssertNil(client.ivAlertConfiguration)
        }
    }

    func testSocketL2AndIVOutboundMessages_encodeExactContract() throws {
        let l2 = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(SocketL2SubscribeMessage(symbol: "SPY", levels: 50))
        ) as? [String: Any]
        XCTAssertEqual(l2?["type"] as? String, "l2Subscribe")
        XCTAssertEqual(l2?["symbol"] as? String, "SPY")
        XCTAssertEqual(l2?["levels"] as? Int, 50)

        let configuration = IVAlertConfigurationDTO(
            enabled: true,
            symbols: [.SPX],
            lookbackMinutes: 30,
            thresholdK: 3,
            consecutiveBreaches: 2,
            warmupMinutes: 15,
            warmupSamples: 10,
            cooldownMinutes: 15
        )
        let iv = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(SocketIVAlertConfigureMessage(data: configuration))
        ) as? [String: Any]
        XCTAssertEqual(iv?["type"] as? String, "ivAlertConfigure")
        XCTAssertNotNil(iv?["data"] as? [String: Any])
    }

    func testSocketDecoder_rejectsOversizeAndInvalidBook() async {
        let oversize = Data(repeating: 0x20, count: QuoteSocketClient.maxSocketPayloadBytes + 1)
        let oversizeResult = await QuoteSocketClient.decodePayloadForTesting(oversize)
        XCTAssertNil(oversizeResult)

        let invalid = Data("""
        {"type":"l2Snapshot","data":{"snapshot":{"symbol":"SPY","provider":"webull","capability":"nasdaq_totalview_non_display","freshness":"fresh","timestamp":"2026-08-05T14:30:00Z","receivedAt":"2026-08-05T14:30:00.100Z","depth":1,"bids":[{"price":501.13,"size":12}],"asks":[{"price":501.12,"size":8}]},"indicators":{"spreadAbs":-0.01,"spreadBps":-0.2,"spreadPercentile":0.4,"topBookImbalance":0.2,"tickPressure":0.1,"depthImbalance":0.15,"cumulativePressure":0.05,"touchDepletion":null}}}
        """.utf8)
        let invalidResult = await QuoteSocketClient.decodePayloadForTesting(invalid)
        XCTAssertNil(invalidResult)

        let invalidReceipt = Data("""
        {"type":"l2Snapshot","data":{"snapshot":{"symbol":"SPY","provider":"webull","capability":"nasdaq_totalview_non_display","freshness":"fresh","timestamp":"2026-08-05T14:30:00Z","receivedAt":"not-a-date","depth":1,"bids":[{"price":501.11,"size":12}],"asks":[{"price":501.12,"size":8}]},"indicators":{"spreadAbs":0.01,"spreadBps":0.2,"spreadPercentile":50,"topBookImbalance":0.2,"tickPressure":0.1,"depthImbalance":0.15,"cumulativePressure":0.05,"touchDepletion":null}}}
        """.utf8)
        let invalidReceiptResult = await QuoteSocketClient.decodePayloadForTesting(invalidReceipt)
        XCTAssertNil(invalidReceiptResult)

        let mismatchedSpread = Data("""
        {"type":"l2Snapshot","data":{"snapshot":{"symbol":"SPY","provider":"webull","capability":"nasdaq_totalview_non_display","freshness":"fresh","timestamp":"2026-08-05T14:30:00Z","receivedAt":"2026-08-05T14:30:00.100Z","depth":1,"bids":[{"price":501.11,"size":12}],"asks":[{"price":501.12,"size":8}]},"indicators":{"spreadAbs":1,"spreadBps":0.2,"spreadPercentile":50,"topBookImbalance":0.2,"tickPressure":0.1,"depthImbalance":0.15,"cumulativePressure":0.05,"touchDepletion":null}}}
        """.utf8)
        let mismatchedSpreadResult = await QuoteSocketClient.decodePayloadForTesting(mismatchedSpread)
        XCTAssertNil(mismatchedSpreadResult)

        let invalidAlert = Data("""
        {"type":"ivAlert","data":{"symbol":"SPX","direction":"expansion","currentIv":-0.24,"baselineIv":0.20,"zScore":3.1,"timestamp":"not-a-date"}}
        """.utf8)
        let invalidAlertResult = await QuoteSocketClient.decodePayloadForTesting(invalidAlert)
        XCTAssertNil(invalidAlertResult)
    }

    func testL2SubscriptionsFailClosedAndEnforceFiftySymbolLimit() async {
        await MainActor.run {
            let disabled = QuoteSocketClient(
                streamURL: URL(string: "wss://l2.test/v1/stream")!,
                l2CapabilityEnabled: false,
                tokenProvider: { "token" }
            )
            XCTAssertFalse(disabled.subscribeL2(symbol: "SPY", levels: 50))
            XCTAssertEqual(disabled.l2Statuses["SPY"]?.unavailableMessage, "L2 capability is disabled on this device.")

            let enabled = QuoteSocketClient(
                streamURL: URL(string: "wss://l2.test/v1/stream")!,
                l2CapabilityEnabled: true,
                tokenProvider: { "token" }
            )
            for index in 0..<QuoteSocketClient.maxL2Subscriptions {
                XCTAssertTrue(enabled.subscribeL2(symbol: "S\(index)", levels: 50))
            }
            XCTAssertFalse(enabled.subscribeL2(symbol: "OVER", levels: 50))
            XCTAssertEqual(
                enabled.l2Statuses["OVER"]?.unavailableMessage,
                "The 50-symbol L2 subscription limit has been reached."
            )
        }
    }

    func testL2UnavailableStatusCancelsPendingFreshnessDeadline() async throws {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let receivedAt = Date()
        let sourceTimestamp = receivedAt.addingTimeInterval(-4.8)
        let snapshot = Data("""
        {"type":"l2Snapshot","data":{"snapshot":{"symbol":"SPY","provider":"webull","capability":"nasdaq_totalview_non_display","freshness":"fresh","timestamp":"\(formatter.string(from: sourceTimestamp))","receivedAt":"\(formatter.string(from: receivedAt))","depth":1,"bids":[{"price":501.11,"size":12}],"asks":[{"price":501.12,"size":8}]},"indicators":{"spreadAbs":0.01,"spreadBps":0.2,"spreadPercentile":50,"topBookImbalance":0.2,"tickPressure":0.1,"depthImbalance":0.15,"cumulativePressure":0.05,"touchDepletion":null}}}
        """.utf8)
        let unavailable = Data("""
        {"type":"l2Status","data":{"availability":"unavailable","symbol":"SPY","provider":"webull","capability":"nasdaq_totalview_non_display","freshness":"stale","reason":"entitlement_missing","message":"L2 entitlement is unavailable.","retryable":false}}
        """.utf8)
        let client = await MainActor.run {
            let client = QuoteSocketClient(
                streamURL: URL(string: "wss://l2.test/v1/stream")!,
                l2CapabilityEnabled: true,
                tokenProvider: { "token" }
            )
            XCTAssertTrue(client.subscribeL2(symbol: "SPY", levels: 1))
            return client
        }

        await client.processPayloadForTesting(snapshot)
        await client.processPayloadForTesting(unavailable)

        let (message, taskCount) = await MainActor.run {
            (client.l2Statuses["SPY"]?.unavailableMessage, client.l2FreshnessTaskCountForTesting)
        }
        XCTAssertEqual(message, "L2 entitlement is unavailable.")
        XCTAssertEqual(taskCount, 0)
    }

    func testL2FiftyLevelPayloadDecodeBenchmark() async {
        let bids = (0..<50).map { index in
            "{\"price\":\(500 - Double(index) * 0.01),\"size\":\(index)}"
        }.joined(separator: ",")
        let asks = (0..<50).map { index in
            "{\"price\":\(500.01 + Double(index) * 0.01),\"size\":\(index)}"
        }.joined(separator: ",")
        let data = Data("""
        {"type":"l2Snapshot","data":{"snapshot":{"symbol":"SPY","provider":"webull","capability":"nasdaq_totalview_non_display","freshness":"fresh","timestamp":"2026-08-05T14:30:00Z","receivedAt":"2026-08-05T14:30:00.100Z","depth":50,"bids":[\(bids)],"asks":[\(asks)]},"indicators":{"spreadAbs":0.01,"spreadBps":0.2,"spreadPercentile":75,"topBookImbalance":0.2,"tickPressure":0.1,"depthImbalance":0.15,"cumulativePressure":0.05,"touchDepletion":null}}}
        """.utf8)
        XCTAssertLessThanOrEqual(data.count, QuoteSocketClient.maxSocketPayloadBytes)
        let iterations = 2_000
        var decodedCount = 0
        let started = Date()
        for _ in 0..<iterations {
            decodedCount += await QuoteSocketClient.decodePayloadForTesting(data) == nil ? 0 : 1
        }
        let averageDecodeSeconds = Date().timeIntervalSince(started) / Double(iterations)
        XCTAssertEqual(decodedCount, iterations)
        XCTAssertLessThan(averageDecodeSeconds, 0.001)
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
