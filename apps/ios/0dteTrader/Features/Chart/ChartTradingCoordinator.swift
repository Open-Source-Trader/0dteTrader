import Combine
import Foundation

/// Bridges the UIKit order-line overlay to the SwiftUI trade screen.
///
/// The overlay raises intent (tapped ✕, dragged a line, pulled a bracket); this
/// turns it into model calls, and surfaces the two things that need a person's
/// confirmation — closing a position and cancelling a working line — as
/// published state the screen renders as alerts. Nothing here sends an order
/// without the user having asked for it on this screen.
@MainActor
final class ChartTradingCoordinator: ObservableObject, OrderLineOverlayDelegate {
    /// Long-press armed a placement at this level.
    @Published var placementRequest: OrderPlacementRequest?
    /// Position the entry line's ✕ is asking to close.
    @Published var positionPendingFlatten: Position?
    /// Working line the ✕ is asking to cancel.
    @Published var orderPendingCancel: ChartOrder?
    @Published var settings: ChartTradingSettings

    private let chartOrders: ChartOrdersModel
    private let settingsStore: SettingsStore
    /// Supplies the contract a new line trades and resolves position symbols;
    /// wired by the trade screen to the loaded chain.
    var selectedContract: () -> OptionContract? = { nil }
    var contractResolver: (String) -> OptionContract? = { _ in nil }
    var defaultOrderType: () -> OrderType = { .mid }
    var onFlattenConfirmed: (Position) -> Void = { _ in }

    init(chartOrders: ChartOrdersModel, settingsStore: SettingsStore) {
        self.chartOrders = chartOrders
        self.settingsStore = settingsStore
        self.settings = settingsStore.chartTradingSettings
    }

    func updateSettings(_ settings: ChartTradingSettings) {
        self.settings = settings
        settingsStore.chartTradingSettings = settings
    }

    /// Entry lines for the chart's symbol: open positions with a recorded
    /// anchor whose contract the loaded chain can identify.
    func entryLines(positions: [Position], symbol: String) -> [EntryLineModel] {
        positions.compactMap { position in
            guard position.quantity != 0,
                  let price = position.underlyingEntryPrice,
                  let contract = contractResolver(position.symbol),
                  contract.underlying == symbol
            else { return nil }
            return EntryLineModel(position: position, contract: contract, price: price)
        }
    }

    // MARK: - OrderLineOverlayDelegate

    func orderLineOverlayDidTapCancel(order: ChartOrder) {
        orderPendingCancel = order
    }

    func orderLineOverlayDidToggleOrderType(order: ChartOrder) {
        Task { await chartOrders.toggleOrderType(id: order.id) }
    }

    func orderLineOverlayDidMove(order: ChartOrder, to price: Double) {
        Task { await chartOrders.move(id: order.id, triggerPrice: rounded(price)) }
    }

    func orderLineOverlayDidTapFlatten(position: Position) {
        positionPendingFlatten = position
    }

    func orderLineOverlayDidDragBracket(entry: EntryLineModel, to price: Double) {
        let kind = bracketKind(
            optionType: entry.contract.optionType,
            quantity: entry.position.quantity,
            entryPrice: entry.price,
            price: price
        )
        // Both legs of one position share a group, so filling either retires the
        // other. Reuse the group an existing leg already established.
        let existing = chartOrders.orders.first {
            $0.contractSymbol == entry.position.symbol && $0.ocoGroupId != nil && $0.isWorking
        }
        let draft = ChartOrderDraftDTO(
            underlying: entry.contract.underlying,
            triggerPrice: rounded(price),
            // Closing an existing position: the opposite side, sized to it.
            side: (entry.position.quantity > 0 ? OrderSide.sell : .buy).rawValue,
            quantity: abs(entry.position.quantity),
            orderType: defaultOrderType().rawValue,
            kind: kind.rawValue,
            optionType: entry.contract.optionType.rawValue,
            expiration: entry.contract.expiration,
            strike: entry.contract.strike,
            ocoGroupId: existing?.ocoGroupId ?? UUID().uuidString
        )
        Task { await chartOrders.create(draft) }
    }

    func orderLineOverlayDidArmPlacement(at price: Double?) {
        guard let price, let contract = selectedContract() else {
            placementRequest = nil
            return
        }
        placementRequest = OrderPlacementRequest(price: rounded(price), contract: contract)
    }

    // MARK: - Confirmed actions

    func confirmCancel() {
        guard let order = orderPendingCancel else { return }
        orderPendingCancel = nil
        Task { await chartOrders.cancel(id: order.id) }
    }

    func confirmFlatten() {
        guard let position = positionPendingFlatten else { return }
        positionPendingFlatten = nil
        onFlattenConfirmed(position)
    }

    func placeFromSheet(side: OrderSide, quantity: Int, orderType: OrderType) async {
        guard let request = placementRequest else { return }
        let draft = ChartOrderDraftDTO(
            underlying: request.contract.underlying,
            triggerPrice: request.price,
            side: side.rawValue,
            quantity: quantity,
            orderType: orderType.rawValue,
            kind: ChartOrderKind.limit.rawValue,
            optionType: request.contract.optionType.rawValue,
            expiration: request.contract.expiration,
            strike: request.contract.strike,
            ocoGroupId: nil
        )
        if await chartOrders.create(draft) != nil {
            placementRequest = nil
        }
    }

    func dismissPlacement() {
        placementRequest = nil
    }

    private func rounded(_ price: Double) -> Double {
        (price * 100).rounded() / 100
    }
}
