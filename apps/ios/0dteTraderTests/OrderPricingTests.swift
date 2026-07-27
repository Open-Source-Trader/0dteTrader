import XCTest
@testable import ZeroDTETrader

/// The pricing selection and the custom-price field.
///
/// The field's parsing is `parseLevelInput`/`sanitiseLevelInput`, already
/// covered by `PlacementGuideTests` — what is exercised here is what the panel
/// does with the result: what reaches the wire, what blocks an arm, and what
/// happens when the contract changes under a typed price.
@MainActor
final class OrderPricingTests: XCTestCase {
    private func makeViewModels() -> (TradeViewModel, OptionsChainViewModel) {
        let baseURL = URL(string: "http://localhost:0")!
        let sessionStore = SessionStore(
            keychainStore: KeychainStore(service: "test.pricing"),
            baseURL: baseURL
        )
        let apiClient = APIClient(baseURL: baseURL, sessionStore: sessionStore)
        return (TradeViewModel(apiClient: apiClient), OptionsChainViewModel(apiClient: apiClient))
    }

    // MARK: - Narrowing to the chart's two-way

    func testChartOrderType_collapsesEveryPricedVariantOntoMid() {
        // A line fires unattended: a bid/ask read now would be stale by the time
        // the level is crossed, and a custom price belongs to the moment it was
        // typed. Only Market survives as itself.
        XCTAssertEqual(OrderType.custom.chartOrderType, .mid)
        XCTAssertEqual(OrderType.bid.chartOrderType, .mid)
        XCTAssertEqual(OrderType.mid.chartOrderType, .mid)
        XCTAssertEqual(OrderType.ask.chartOrderType, .mid)
        XCTAssertEqual(OrderType.market.chartOrderType, .market)
    }

    func testChartOrderType_decodesOnlyTheTwoALineCanHold() {
        XCTAssertEqual(ChartOrderType(rawValue: "mid"), .mid)
        XCTAssertEqual(ChartOrderType(rawValue: "market"), .market)
        for widened in ["custom", "bid", "ask"] {
            XCTAssertNil(ChartOrderType(rawValue: widened), "\(widened) must not reach a line")
        }
    }

    func testOrderType_keepsTheRawValuesAlreadyPersisted() {
        // Rows and in-flight requests written before this widened say `mid` or
        // `market`; widening must not have renamed either.
        XCTAssertEqual(OrderType(rawValue: "mid"), .mid)
        XCTAssertEqual(OrderType(rawValue: "market"), .market)
        XCTAssertEqual(OrderType.mid.rawValue, "mid")
        XCTAssertEqual(OrderType.market.rawValue, "market")
    }

    // MARK: - The custom price

    func testSetCustomLimitPrice_roundsToTheContractTick() {
        let (tradeViewModel, _) = makeViewModels()
        tradeViewModel.setCustomLimitPrice(2.456)
        XCTAssertEqual(tradeViewModel.customLimitPrice, 2.46)
        tradeViewModel.setCustomLimitPrice(nil)
        XCTAssertNil(tradeViewModel.customLimitPrice)
    }

    func testCanArm_blocksCustomWithNoPriceAndNothingElse() {
        let (tradeViewModel, _) = makeViewModels()
        for type in [OrderType.bid, .mid, .ask, .market] {
            tradeViewModel.orderType = type
            XCTAssertTrue(tradeViewModel.canArm, "\(type) needs no typed price")
        }
        tradeViewModel.orderType = .custom
        XCTAssertFalse(tradeViewModel.canArm)
        tradeViewModel.setCustomLimitPrice(2.45)
        XCTAssertTrue(tradeViewModel.canArm)
    }

    func testClearCustomLimitPrice_dropsThePriceAndMovesTheHighlightOff() {
        // A premium is only meaningful for the contract it was typed against, so
        // a contract change must not leave it armed on a different one.
        let (tradeViewModel, _) = makeViewModels()
        tradeViewModel.orderType = .custom
        tradeViewModel.setCustomLimitPrice(2.45)

        tradeViewModel.clearCustomLimitPrice()

        XCTAssertNil(tradeViewModel.customLimitPrice)
        XCTAssertEqual(tradeViewModel.orderType, .mid)
    }

    func testClearCustomLimitPrice_leavesAnotherSelectionAlone() {
        let (tradeViewModel, _) = makeViewModels()
        tradeViewModel.orderType = .ask
        tradeViewModel.clearCustomLimitPrice()
        XCTAssertEqual(tradeViewModel.orderType, .ask)
    }

    // MARK: - What reaches the wire

    func testArm_sendsTheLimitPriceOnlyForCustom() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        chainViewModel.isAutoMode = true

        tradeViewModel.orderType = .custom
        tradeViewModel.setCustomLimitPrice(2.4)
        tradeViewModel.arm(side: .buy, underlying: "SPY", chainViewModel: chainViewModel)
        XCTAssertEqual(tradeViewModel.armedTicket?.request.orderType, "custom")
        XCTAssertEqual(tradeViewModel.armedTicket?.request.limitPrice, 2.4)

        // The other four are priced from the server's own quote; a number
        // alongside them is one the server rejects outright.
        for type in [OrderType.bid, .mid, .ask, .market] {
            tradeViewModel.orderType = type
            tradeViewModel.arm(side: .buy, underlying: "SPY", chainViewModel: chainViewModel)
            XCTAssertEqual(tradeViewModel.armedTicket?.request.orderType, type.rawValue)
            XCTAssertNil(tradeViewModel.armedTicket?.request.limitPrice, "\(type) carries no price")
        }
    }

    func testArm_refusesCustomWithNoPriceRatherThanSendingNone() {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        chainViewModel.isAutoMode = true
        tradeViewModel.orderType = .custom

        tradeViewModel.arm(side: .buy, underlying: "SPY", chainViewModel: chainViewModel)

        XCTAssertNil(tradeViewModel.armedTicket)
        XCTAssertEqual(tradeViewModel.toast?.style, .error)
    }

    func testArm_omitsLimitPriceFromTheEncodedBodyEntirely() throws {
        // Not merely nil in Swift: the server's rule is "rejected unless
        // custom", and an explicit `"limitPrice": null` on the wire would be a
        // value it has to decide about. `JSONEncoder` drops a nil Optional.
        let (tradeViewModel, chainViewModel) = makeViewModels()
        chainViewModel.isAutoMode = true
        tradeViewModel.orderType = .mid
        tradeViewModel.arm(side: .buy, underlying: "SPY", chainViewModel: chainViewModel)

        let request = try XCTUnwrap(tradeViewModel.armedTicket?.request)
        let body = try JSONEncoder().encode(request)
        let json = try XCTUnwrap(String(bytes: body, encoding: .utf8))
        XCTAssertFalse(json.contains("limitPrice"))
    }

    // MARK: - Labels

    func testPricingDescription_saysWhetherItIsALimitOrAMarketOrder() {
        XCTAssertEqual(OrderType.custom.pricingDescription, "Limit at your price")
        XCTAssertEqual(OrderType.bid.pricingDescription, "Limit at bid")
        XCTAssertEqual(OrderType.mid.pricingDescription, "Limit at mid")
        XCTAssertEqual(OrderType.ask.pricingDescription, "Limit at ask")
        XCTAssertEqual(OrderType.market.pricingDescription, "Market")
    }
}
