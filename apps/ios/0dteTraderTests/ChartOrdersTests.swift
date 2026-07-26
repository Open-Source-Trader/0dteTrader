import XCTest
@testable import ZeroDTETrader

private func makeOrder(
    id: String = "co-1",
    underlying: String = "SPY",
    triggerPrice: Double = 98,
    armPrice: Double = 100,
    kind: ChartOrderKind = .limit,
    orderType: ChartOrderType = .mid,
    status: ChartOrderStatus = .working,
    quantity: Int = 1
) -> ChartOrder {
    ChartOrder(
        id: id,
        underlying: underlying,
        triggerPrice: triggerPrice,
        armPrice: armPrice,
        side: .buy,
        quantity: quantity,
        orderType: orderType,
        kind: kind,
        optionType: .call,
        expiration: "2026-07-27",
        strike: 101,
        contractSymbol: "SPY260727C00101000",
        ocoGroupId: nil,
        status: status,
        expiresAt: nil,
        brokerOrderId: nil,
        lastError: nil
    )
}

final class ChartOrderCrossingTests: XCTestCase {
    func testArmedAbove_firesOnlyOnTheWayDown() {
        let order = makeOrder(triggerPrice: 98, armPrice: 100)

        XCTAssertTrue(chartOrderCrossed(order, previous: 100, current: 97))
        XCTAssertFalse(chartOrderCrossed(order, previous: 100, current: 99))
        XCTAssertFalse(chartOrderCrossed(order, previous: 97, current: 100))
    }

    func testArmedBelow_firesOnlyOnTheWayUp() {
        let order = makeOrder(triggerPrice: 105, armPrice: 100)

        XCTAssertTrue(chartOrderCrossed(order, previous: 100, current: 106))
        XCTAssertFalse(chartOrderCrossed(order, previous: 100, current: 104))
        XCTAssertFalse(chartOrderCrossed(order, previous: 106, current: 100))
    }

    func testTouchingTheLevelExactlyCounts() {
        XCTAssertTrue(chartOrderCrossed(makeOrder(triggerPrice: 98), previous: 100, current: 98))
        XCTAssertTrue(
            chartOrderCrossed(makeOrder(triggerPrice: 105), previous: 100, current: 105)
        )
    }

    /// A relaunch or a backgrounded app leaves no observed price; starting the
    /// segment at the line's own arm price is what stops a gap from slipping
    /// through unnoticed.
    func testGapFromArmPriceStillCrosses() {
        XCTAssertTrue(chartOrderCrossed(makeOrder(triggerPrice: 98, armPrice: 100),
                                        previous: 100,
                                        current: 90))
    }

    func testNonFinitePricesNeverFire() {
        let order = makeOrder()

        XCTAssertFalse(chartOrderCrossed(order, previous: .nan, current: 90))
        XCTAssertFalse(chartOrderCrossed(order, previous: 100, current: .infinity))
    }
}

/// Which way is "up" for a bracket depends on the contract, not the screen.
/// Getting this backwards would put every put's target where the position loses
/// money — the most expensive thing this feature could get wrong.
final class BracketDirectionTests: XCTestCase {
    func testProfitDirection_longCallUp_longPutDown() {
        XCTAssertEqual(positionProfitDirection(optionType: .call, quantity: 1), 1)
        XCTAssertEqual(positionProfitDirection(optionType: .put, quantity: 1), -1)
    }

    func testProfitDirection_shortPositionsInvert() {
        XCTAssertEqual(positionProfitDirection(optionType: .call, quantity: -1), -1)
        XCTAssertEqual(positionProfitDirection(optionType: .put, quantity: -1), 1)
    }

    func testLongCall_upIsTarget_downIsStop() {
        XCTAssertEqual(bracketKind(optionType: .call, quantity: 1, entryPrice: 100, price: 105), .target)
        XCTAssertEqual(bracketKind(optionType: .call, quantity: 1, entryPrice: 100, price: 95), .stop)
    }

    func testLongPut_downIsTarget_becauseThatIsWhereItWins() {
        XCTAssertEqual(bracketKind(optionType: .put, quantity: 1, entryPrice: 100, price: 95), .target)
        XCTAssertEqual(bracketKind(optionType: .put, quantity: 1, entryPrice: 100, price: 105), .stop)
    }

    func testShortCallInvertsAgain() {
        XCTAssertEqual(bracketKind(optionType: .call, quantity: -1, entryPrice: 100, price: 95), .target)
        XCTAssertEqual(bracketKind(optionType: .call, quantity: -1, entryPrice: 100, price: 105), .stop)
    }
}

/// The snapshot a load returns is a read from before it arrived, so a push that
/// overtook it in flight is newer. Replacing wholesale would put a fired line
/// back on the chart as live and draggable — the desktop store is pinned to the
/// same behaviour in chartOrders.test.ts.
@MainActor
final class ChartOrdersResyncTests: XCTestCase {
    private func makeModel() -> ChartOrdersModel {
        let baseURL = URL(string: "http://localhost:0")!
        let sessionStore = SessionStore(
            keychainStore: KeychainStore(service: "test.resync"),
            baseURL: baseURL
        )
        return ChartOrdersModel(apiClient: APIClient(baseURL: baseURL, sessionStore: sessionStore))
    }

    /// A push applied while a load is in flight must survive that load. The
    /// request here fails (no server), which is the same merge path: the guard
    /// must not discard what the socket delivered meanwhile.
    func testPushDuringLoadIsNotLostWhenTheSnapshotLands() async {
        let model = makeModel()
        model.applyServerUpdate(makeOrder(status: .working))

        async let loading: Void = model.load()
        model.applyServerUpdate(makeOrder(status: .triggered))
        await loading

        XCTAssertEqual(model.order(id: "co-1")?.status, .triggered)
    }

    func testRetiredLineStaysGoneAcrossALoad() async {
        let model = makeModel()
        model.applyServerUpdate(makeOrder(status: .working))

        async let loading: Void = model.load()
        model.applyServerUpdate(makeOrder(status: .cancelled))
        await loading

        XCTAssertNil(model.order(id: "co-1"))
    }

    /// reset() bumps the sequence so a snapshot still in flight for the previous
    /// account cannot land after the switch.
    func testResetDiscardsAnInFlightSnapshot() async {
        let model = makeModel()
        model.applyServerUpdate(makeOrder(status: .working))

        async let loading: Void = model.load()
        model.reset()
        await loading

        XCTAssertTrue(model.orders.isEmpty)
    }
}

@MainActor
final class ChartTradingCoordinatorCancelTests: XCTestCase {
    private func makeCoordinator() -> (ChartTradingCoordinator, ChartOrdersModel) {
        let baseURL = URL(string: "http://localhost:0")!
        let sessionStore = SessionStore(
            keychainStore: KeychainStore(service: "test.coordinator"),
            baseURL: baseURL
        )
        let apiClient = APIClient(baseURL: baseURL, sessionStore: sessionStore)
        let orders = ChartOrdersModel(apiClient: apiClient)
        return (
            ChartTradingCoordinator(chartOrders: orders, settingsStore: SettingsStore()),
            orders
        )
    }

    func testTapCancel_workingLine_asksForConfirmation() {
        let (coordinator, _) = makeCoordinator()

        coordinator.orderLineOverlayDidTapCancel(order: makeOrder(status: .working))

        XCTAssertEqual(coordinator.orderPendingCancel?.id, "co-1")
    }

    /// A fired line's broker order is live; confirming "nothing was sent to the
    /// broker" would misrepresent it, so ✕ just clears the chart marker.
    func testTapCancel_triggeredLine_dismissesWithoutConfirmation() async {
        let (coordinator, orders) = makeCoordinator()
        orders.applyServerUpdate(makeOrder(status: .triggered))

        coordinator.orderLineOverlayDidTapCancel(order: makeOrder(status: .triggered))
        await Task.yield()

        XCTAssertNil(coordinator.orderPendingCancel)
        // The local-dismissal branch returns before any request, so the line is
        // gone from the chart even with no server reachable.
        XCTAssertNil(orders.order(id: "co-1"))
    }

    func testTapCancel_failedLine_dismissesWithoutConfirmation() async {
        let (coordinator, orders) = makeCoordinator()
        orders.applyServerUpdate(makeOrder(status: .failed))

        coordinator.orderLineOverlayDidTapCancel(order: makeOrder(status: .failed))
        await Task.yield()

        XCTAssertNil(coordinator.orderPendingCancel)
        XCTAssertNil(orders.order(id: "co-1"))
    }
}

final class ChartOrderLabelTests: XCTestCase {
    func testKindLabels() {
        XCTAssertEqual(makeOrder(kind: .limit).kindLabel, "LMT")
        XCTAssertEqual(makeOrder(kind: .target).kindLabel, "TP")
        XCTAssertEqual(makeOrder(kind: .stop).kindLabel, "STP")
    }

    /// A triggered line that has not filled is still exposed; "SENT" would read
    /// as done, which is exactly the wrong impression for an unfilled stop.
    func testTriggeredReadsWorkingNotSent() {
        XCTAssertEqual(makeOrder(status: .triggered).kindLabel, "WORKING")
        XCTAssertEqual(makeOrder(status: .failed).kindLabel, "FAILED")
    }

    /// Same width in both states, so the row does not jump when it is toggled.
    func testExecutionLabelsAreEqualWidth() {
        XCTAssertEqual(makeOrder(orderType: .mid).orderTypeLabel, "MID")
        XCTAssertEqual(makeOrder(orderType: .market).orderTypeLabel, "MKT")
        XCTAssertEqual(
            makeOrder(orderType: .mid).orderTypeLabel.count,
            makeOrder(orderType: .market).orderTypeLabel.count
        )
    }

    func testVisibilityKeepsFailedLinesOnTheChart() {
        XCTAssertTrue(makeOrder(status: .working).isVisible)
        XCTAssertTrue(makeOrder(status: .triggered).isVisible)
        XCTAssertTrue(makeOrder(status: .failed).isVisible)
        XCTAssertFalse(makeOrder(status: .cancelled).isVisible)
        XCTAssertFalse(makeOrder(status: .expired).isVisible)
    }
}

final class ChartTradingSettingsDecodingTests: XCTestCase {
    private func decode(_ json: String) -> ChartTradingSettings? {
        try? JSONDecoder().decode(ChartTradingSettings.self, from: Data(json.utf8))
    }

    /// The decode bound and the settings stepper must agree. When decoding was
    /// wider, a stored value out of range armed a default size the stepper could
    /// neither show nor correct.
    func testRejectsAQuantityTheStepperCouldNotRepresent() {
        let max = ChartTradingSettings.defaultQuantityRange.upperBound
        for quantity in [max + 1, 1000, 0, -3] {
            let decoded = decode("{\"defaultQuantity\": \(quantity)}")
            XCTAssertEqual(decoded?.defaultQuantity, ChartTradingSettings.default.defaultQuantity)
        }
    }

    func testKeepsBothEndsOfTheStepperRange() {
        for quantity in [
            ChartTradingSettings.defaultQuantityRange.lowerBound,
            ChartTradingSettings.defaultQuantityRange.upperBound,
        ] {
            XCTAssertEqual(decode("{\"defaultQuantity\": \(quantity)}")?.defaultQuantity, quantity)
        }
    }

    func testMissingFieldsFallBackToDefaults() {
        XCTAssertEqual(decode("{}"), ChartTradingSettings.default)
    }
}

final class ChartOrderDecodingTests: XCTestCase {
    private func dto(
        side: String = "buy",
        kind: String = "limit",
        status: String = "working",
        orderType: String = "mid"
    ) -> ChartOrderDTO {
        ChartOrderDTO(
            id: "co-1",
            underlying: "SPY",
            triggerPrice: 98,
            armPrice: 100,
            side: side,
            quantity: 1,
            orderType: orderType,
            kind: kind,
            optionType: "call",
            expiration: "2026-07-27",
            strike: 101,
            contractSymbol: "SPY260727C00101000",
            ocoGroupId: nil,
            status: status,
            createdAt: "2026-07-24T15:00:00.000Z",
            expiresAt: "2026-07-27T20:00:00.000Z",
            triggeredAt: nil,
            brokerOrderId: nil,
            lastError: nil
        )
    }

    func testDecodesAValidPayload() {
        let order = ChartOrder(dto: dto())

        XCTAssertEqual(order?.id, "co-1")
        XCTAssertEqual(order?.kind, .limit)
        XCTAssertNotNil(order?.expiresAt)
    }

    /// A line whose side or kind this build cannot read would arm a trade it
    /// cannot describe — better to drop it than to guess.
    func testRejectsUnknownEnums() {
        XCTAssertNil(ChartOrder(dto: dto(side: "hedge")))
        XCTAssertNil(ChartOrder(dto: dto(kind: "trailing")))
        XCTAssertNil(ChartOrder(dto: dto(status: "queued")))
        XCTAssertNil(ChartOrder(dto: dto(orderType: "limit")))
    }
}

@MainActor
final class ChartOrdersModelTests: XCTestCase {
    private func makeModel() -> ChartOrdersModel {
        let baseURL = URL(string: "http://localhost:0")!
        let sessionStore = SessionStore(
            keychainStore: KeychainStore(service: "test.chartorders"),
            baseURL: baseURL
        )
        return ChartOrdersModel(apiClient: APIClient(baseURL: baseURL, sessionStore: sessionStore))
    }

    /// Seeds the model without a network round trip.
    private func seed(_ model: ChartOrdersModel, _ orders: [ChartOrder]) {
        for order in orders { model.applyServerUpdate(order) }
    }

    func testCrossedOrders_firesOnATickThroughTheLevel() {
        let model = makeModel()
        seed(model, [makeOrder(triggerPrice: 98, armPrice: 100)])

        XCTAssertTrue(model.crossedOrders(underlying: "SPY", last: 101).isEmpty)
        XCTAssertEqual(model.crossedOrders(underlying: "SPY", last: 97).map(\.id), ["co-1"])
    }

    func testCrossedOrders_doesNotFireOnCreationWhenPriceHasNotMoved() {
        let model = makeModel()
        seed(model, [makeOrder(triggerPrice: 98, armPrice: 100)])

        XCTAssertTrue(model.crossedOrders(underlying: "SPY", last: 99).isEmpty)
    }

    func testCrossedOrders_catchesAGapOnTheFirstTick() {
        let model = makeModel()
        seed(model, [makeOrder(triggerPrice: 98, armPrice: 100)])

        XCTAssertEqual(model.crossedOrders(underlying: "SPY", last: 90).count, 1)
    }

    func testCrossedOrders_ignoresOtherUnderlyingsAndNonWorkingLines() {
        let model = makeModel()
        seed(model, [
            makeOrder(id: "a", underlying: "SPY", triggerPrice: 98, armPrice: 100),
            makeOrder(id: "b", underlying: "QQQ", triggerPrice: 98, armPrice: 100),
            makeOrder(id: "c", underlying: "SPY", triggerPrice: 98, armPrice: 100, status: .triggered),
        ])

        XCTAssertEqual(model.crossedOrders(underlying: "SPY", last: 90).map(\.id), ["a"])
    }

    func testCrossedOrders_rejectsJunkPrices() {
        let model = makeModel()
        seed(model, [makeOrder(triggerPrice: 98, armPrice: 100)])

        XCTAssertTrue(model.crossedOrders(underlying: "SPY", last: .nan).isEmpty)
        XCTAssertTrue(model.crossedOrders(underlying: "SPY", last: 0).isEmpty)
    }

    func testVisibleOrders_onlyTheCurrentChart() {
        let model = makeModel()
        seed(model, [
            makeOrder(id: "a", underlying: "SPY"),
            makeOrder(id: "b", underlying: "QQQ"),
        ])
        model.setSymbol("SPY")

        XCTAssertEqual(model.visibleOrders.map(\.id), ["a"])
    }

    func testApplyServerUpdate_removesARetiredLine() {
        let model = makeModel()
        seed(model, [makeOrder()])
        model.setSymbol("SPY")

        model.applyServerUpdate(makeOrder(status: .cancelled))

        XCTAssertNil(model.order(id: "co-1"))
    }

    /// Practice and live lines are separate sets; a mode switch must not leave
    /// stale price history that would re-arm a line from the wrong reference.
    func testReset_clearsOrdersAndPriceHistory() {
        let model = makeModel()
        seed(model, [makeOrder(triggerPrice: 98, armPrice: 100)])
        _ = model.crossedOrders(underlying: "SPY", last: 99)

        model.reset()
        seed(model, [makeOrder(triggerPrice: 98, armPrice: 100)])

        XCTAssertEqual(model.crossedOrders(underlying: "SPY", last: 90).count, 1)
    }
}
