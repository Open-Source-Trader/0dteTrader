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
    /// The `+` handle armed a placement at this level.
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
    var defaultOrderType: () -> ChartOrderType = { .mid }
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
    ///
    /// The level prefers the authoritative fill-time record and falls back to
    /// the placement-time estimate. An estimate line is display only — drawn
    /// with a "~" marker, and it neither starts a bracket drag nor classifies
    /// one; only its ✕ (close position) stays live.
    func entryLines(positions: [Position], symbol: String) -> [EntryLineModel] {
        positions.compactMap { position in
            guard position.quantity != 0,
                  let price = position.underlyingEntryPrice ?? position.underlyingEntryEstimate,
                  let contract = contractResolver(position.symbol),
                  contract.underlying == symbol
            else { return nil }
            return EntryLineModel(
                position: position,
                contract: contract,
                price: price,
                isEstimate: position.underlyingEntryPrice == nil
            )
        }
    }

    // MARK: - OrderLineOverlayDelegate

    func orderLineOverlayDidTapCancel(order: ChartOrder) {
        // Only a working line has something to cancel. A triggered or failed
        // line already reached the broker, so ✕ just clears it from the chart —
        // confirming it with "nothing was sent to the broker" would be a lie
        // about a live order. Matches the desktop store, which dismisses
        // terminal lines silently.
        guard order.isWorking else {
            Task { await chartOrders.cancel(id: order.id) }
            return
        }
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
        // Nil for an estimate line: classification must behave exactly as if
        // there were no entry line, so nothing is created or moved. The
        // overlay already refuses the drag; this is the backstop.
        guard let kind = bracketKind(entry: entry, price: price) else { return }
        let siblings = chartOrders.orders.filter {
            $0.contractSymbol == entry.position.symbol && $0.ocoGroupId != nil && $0.isWorking
        }
        // A leg of the same kind already exists (e.g. a second drag above entry
        // on a long call, both classified .target): move it to the new level
        // rather than creating a second one. OCO cancels siblings by group
        // membership, not by kind, so two targets sharing a group would
        // silently retire one of them on fire — the user would lose whichever
        // the market did not reach first with no warning.
        if let sameKind = siblings.first(where: { $0.kind == kind }) {
            Task { await chartOrders.move(id: sameKind.id, triggerPrice: rounded(price)) }
            return
        }
        // Both legs of one position share a group, so filling either retires the
        // other. Reuse the group an existing leg already established.
        let existing = siblings.first
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

    func orderLineOverlayDidRequestPlacement(at price: Double) {
        // Backstop behind the overlay's `canPlaceChartOrder` gate: whatever
        // the overlay believed when the tap landed, a placement card must
        // never open for an unquoted contract — a CURR leg synthesized from
        // its OCC symbol is selected long before its quotes exist.
        guard let contract = selectedContract(), contract.hasTradeableQuote else { return }
        placementRequest = OrderPlacementRequest(price: rounded(price), contract: contract)
    }

    /// Closes an open card whose contract is no longer the one a new line would
    /// trade.
    ///
    /// The card names a contract, and that contract is frozen when the card
    /// opens — but the option chain underneath it stays live in the split
    /// layout, so selecting a different strike would otherwise leave the card
    /// showing the 6000C while PLACE armed... the 6000C, against a chain that
    /// now says 6010P. Dismissing on the change is what the desktop twin gets
    /// for free from its window-level outside-press listener.
    func dismissPlacementIfContractChanged() {
        guard let request = placementRequest else { return }
        if selectedContract()?.symbol != request.contract.symbol { placementRequest = nil }
    }

    /// The window's own price field moved the level; the guide follows it.
    func updatePlacementPrice(_ price: Double) {
        guard let request = placementRequest else { return }
        placementRequest = OrderPlacementRequest(price: rounded(price), contract: request.contract)
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

    func placeFromSheet(side: OrderSide, quantity: Int, orderType: ChartOrderType) async {
        guard let request = placementRequest else { return }
        // Re-checked at the moment of arming, not just when the selection
        // changes: the dismissal above should make this unreachable, but the
        // card's displayed contract and the armed contract have to be the same
        // thing by construction, not by two views agreeing to stay in sync.
        // Closing rather than substituting — the user aimed at what the card
        // said, and silently arming something else is the failure this guards.
        guard selectedContract()?.symbol == request.contract.symbol else {
            placementRequest = nil
            return
        }
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
