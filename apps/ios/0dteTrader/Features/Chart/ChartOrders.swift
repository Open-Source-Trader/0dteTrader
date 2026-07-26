import Foundation

/// What a line is for. The colour on the chart carries this too — the label is
/// the confirmation, not the only signal.
enum ChartOrderKind: String, Codable, Sendable {
    case limit
    case target
    case stop

    var shortLabel: String {
        switch self {
        case .limit: return "LMT"
        case .target: return "TP"
        case .stop: return "STP"
        }
    }
}

enum ChartOrderStatus: String, Codable, Sendable {
    case working
    case triggered
    case filled
    case cancelled
    case failed
    case expired
}

/// A resting order line drawn on the candle chart. The broker never sees it:
/// the level is watched against the UNDERLYING, and a crossing fires a normal
/// mid/market option order.
struct ChartOrder: Equatable, Identifiable, Sendable {
    let id: String
    let underlying: String
    var triggerPrice: Double
    /// Underlying price when the line was armed. The fire test runs
    /// armPrice → last, so a gap or a relaunch cannot step over a level.
    var armPrice: Double
    let side: OrderSide
    var quantity: Int
    var orderType: ChartOrderType
    let kind: ChartOrderKind
    let optionType: OptionType
    let expiration: String
    let strike: Double
    let contractSymbol: String
    let ocoGroupId: String?
    var status: ChartOrderStatus
    let expiresAt: Date?
    var brokerOrderId: String?
    var lastError: String?

    /// Still able to fire: drawn solid, draggable, and cancellable.
    var isWorking: Bool { status == .working }

    /// Worth drawing at all. A failed line stays up so the reason is visible
    /// rather than the line silently disappearing.
    var isVisible: Bool { status == .working || status == .triggered || status == .failed }

    /// The side of the trigger this line waits to be crossed *from*.
    var armedAbove: Bool { armPrice >= triggerPrice }

    /// What the kind pill reads. A triggered line says WORKING, not SENT: an
    /// unfilled mid order is still exposed, and "sent" would read as done.
    var kindLabel: String {
        switch status {
        case .failed: return "FAILED"
        case .triggered: return "WORKING"
        default: return kind.shortLabel
        }
    }

    /// The tappable execution pill. `MKT` is abbreviated so the pill keeps its
    /// width across a toggle and the row does not jump.
    var orderTypeLabel: String { orderType.shortLabel }
}

extension ChartOrder {
    /// Nil for any unrecognised enum: a line whose side or kind we cannot read
    /// would arm a trade we cannot describe.
    init?(dto: ChartOrderDTO) {
        guard let side = OrderSide(rawValue: dto.side),
              let orderType = ChartOrderType(rawValue: dto.orderType),
              let kind = ChartOrderKind(rawValue: dto.kind),
              let optionType = OptionType(rawValue: dto.optionType),
              let status = ChartOrderStatus(rawValue: dto.status)
        else { return nil }
        self.init(
            id: dto.id,
            underlying: dto.underlying,
            triggerPrice: dto.triggerPrice,
            armPrice: dto.armPrice,
            side: side,
            quantity: dto.quantity,
            orderType: orderType,
            kind: kind,
            optionType: optionType,
            expiration: dto.expiration,
            strike: dto.strike,
            contractSymbol: dto.contractSymbol,
            ocoGroupId: dto.ocoGroupId,
            status: status,
            expiresAt: DateParsing.dateTime(dto.expiresAt),
            brokerOrderId: dto.brokerOrderId,
            lastError: dto.lastError
        )
    }
}

/// Whether a move from `previous` to `current` crosses the line's trigger from
/// the side it was armed on.
///
/// Callers pass the last price they actually observed, or the line's own
/// `armPrice` when they have not seen one — that is what makes a relaunch or a
/// backgrounded app safe. Testing the armed side (rather than a bare crossing)
/// is what stops a buy limit placed below an already-lower price from firing
/// the instant it is created.
func chartOrderCrossed(_ order: ChartOrder, previous: Double, current: Double) -> Bool {
    guard previous.isFinite, current.isFinite else { return false }
    return order.armedAbove
        ? previous >= order.triggerPrice && current <= order.triggerPrice
        : previous <= order.triggerPrice && current >= order.triggerPrice
}

/// The direction a position profits in, as a sign on the UNDERLYING.
///
/// This is why a bracket cannot simply map screen-up to "target": a long put
/// gains when the underlying falls, so its target sits BELOW the entry line and
/// its stop above. Long call → +1, long put → -1; a short position inverts.
func positionProfitDirection(optionType: OptionType, quantity: Int) -> Double {
    let isLong = quantity >= 0
    let isCall = optionType == .call
    return isLong == isCall ? 1 : -1
}

/// Whether a leg dragged to `price` from an entry at `entryPrice` is the target
/// or the stop.
func bracketKind(
    optionType: OptionType,
    quantity: Int,
    entryPrice: Double,
    price: Double
) -> ChartOrderKind {
    let profitable = (price - entryPrice) * positionProfitDirection(
        optionType: optionType,
        quantity: quantity
    ) > 0
    return profitable ? .target : .stop
}

/// Chart order lines for the signed-in account. The server is the source of
/// truth: every mutation is a request and the response replaces the local row.
///
/// Triggering is deliberately not a local order submission — when the quote
/// stream crosses a level this asks the server to fire that line, so the app
/// and the server-side watcher take the identical path and one crossing can
/// only ever produce one broker order.
@MainActor
final class ChartOrdersModel: ObservableObject {
    @Published private(set) var orders: [ChartOrder] = []
    @Published var selectedId: String?
    @Published private(set) var errorMessage: String?

    /// Chart symbol currently displayed; lines for other underlyings stay
    /// loaded but are not drawn.
    private(set) var symbol = ""

    private let apiClient: APIClient
    /// Lines with a trigger request in flight, so a burst of ticks fires once.
    private var firing: Set<String> = []
    /// Bumped per load so a superseded snapshot cannot land after a newer one.
    private var loadSeq = 0
    /// Ids the socket updated while a load was in flight. The push is strictly
    /// newer than the read that produced the snapshot, so it must win.
    private var pushedDuringLoad: Set<String> = []
    /// Last price seen per underlying — the left end of the crossing segment.
    private var lastPrices: [String: Double] = [:]

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    /// Lines drawn on the current chart.
    var visibleOrders: [ChartOrder] {
        orders.filter { $0.underlying == symbol && $0.isVisible }
    }

    func order(id: String) -> ChartOrder? {
        orders.first { $0.id == id }
    }

    func setSymbol(_ symbol: String) {
        guard symbol != self.symbol else { return }
        self.symbol = symbol
        selectedId = nil
    }

    /// Re-reads the account's lines. Called on appear, on every socket
    /// reconnect, and on foreground — pushes that landed while the stream was
    /// down are gone for good.
    ///
    /// Merges rather than replaces. A snapshot is a read from some instant
    /// before it arrived, so a push that overtook it in flight is newer;
    /// replacing wholesale would resurrect a line the watcher just fired.
    func load() async {
        loadSeq += 1
        let seq = loadSeq
        pushedDuringLoad.removeAll()
        do {
            let snapshot = try await apiClient.chartOrders().compactMap(ChartOrder.init(dto:))
            guard seq == loadSeq else { return } // a newer load superseded this one
            let current = orders
            var merged = snapshot.filter { !pushedDuringLoad.contains($0.id) }
            // Re-apply what the socket told us mid-flight. A pushed line that is
            // no longer in local state was retired — it stays gone.
            for id in pushedDuringLoad {
                if let pushed = current.first(where: { $0.id == id }) { merged.append(pushed) }
            }
            pushedDuringLoad.removeAll()
            orders = merged
            errorMessage = nil
        } catch let error as APIError {
            guard seq == loadSeq else { return }
            errorMessage = error.userMessage
        } catch {
            guard seq == loadSeq else { return }
            errorMessage = error.localizedDescription
        }
    }

    /// Clears everything — used when the trading mode changes, since practice
    /// and live lines are separate sets and must never be shown together.
    func reset() {
        firing.removeAll()
        lastPrices.removeAll()
        pushedDuringLoad.removeAll()
        loadSeq += 1 // discard any snapshot still in flight for the old account
        orders = []
        selectedId = nil
        errorMessage = nil
    }

    @discardableResult
    func create(_ draft: ChartOrderDraftDTO) async -> ChartOrder? {
        do {
            guard let order = ChartOrder(dto: try await apiClient.createChartOrder(draft)) else {
                errorMessage = "The server returned an order this build cannot read."
                return nil
            }
            upsert(order)
            selectedId = order.id
            errorMessage = nil
            Haptics.success()
            return order
        } catch let error as APIError {
            errorMessage = error.userMessage
            Haptics.error()
            return nil
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// Commits a drag. The server re-arms from the live quote, so the returned
    /// row — not the dragged-to price — is what gets stored.
    func move(id: String, triggerPrice: Double) async {
        await patch(id: id, ChartOrderPatchDTO(triggerPrice: triggerPrice))
    }

    /// Flips MID ↔ MKT for one line, optimistically so the pill responds at once.
    func toggleOrderType(id: String) async {
        guard let current = order(id: id), current.isWorking else { return }
        let next: ChartOrderType = current.orderType == .mid ? .market : .mid
        var optimistic = current
        optimistic.orderType = next
        upsert(optimistic)
        Haptics.selection()
        do {
            guard let updated = ChartOrder(
                dto: try await apiClient.updateChartOrder(
                    id: id,
                    patch: ChartOrderPatchDTO(orderType: next.rawValue)
                )
            ) else { return }
            upsert(updated)
            errorMessage = nil
        } catch let error as APIError {
            upsert(current) // revert
            errorMessage = error.userMessage
        } catch {
            upsert(current)
            errorMessage = error.localizedDescription
        }
    }

    /// The ✕ on a line. A working line is cancelled server-side; a terminal one
    /// (a failed fire, or one the watcher already sent) has nothing to cancel,
    /// so ✕ simply dismisses it — otherwise a failed line would sit there
    /// un-clearable, telling the user nothing they can act on.
    func cancel(id: String) async {
        if let current = order(id: id), !current.isWorking {
            remove(id: id)
            Haptics.impact(.light)
            return
        }
        do {
            try await apiClient.cancelChartOrder(id: id)
            remove(id: id)
            errorMessage = nil
            Haptics.impact(.light)
        } catch let error as APIError {
            // A line the watcher fired a moment ago is no longer cancellable;
            // reload so the chart shows what happened, not a stale line.
            errorMessage = error.userMessage
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Server-side watcher pushed a state change over the socket.
    func applyServerUpdate(_ order: ChartOrder) {
        firing.remove(order.id)
        pushedDuringLoad.insert(order.id)
        if order.isVisible {
            upsert(order)
        } else {
            remove(id: order.id)
        }
    }

    /// Feeds a live tick in, returning the lines whose level it crossed. The
    /// caller fires them; the segment tested starts at the last price this app
    /// actually saw — or the line's own arm price when it has seen none — so a
    /// relaunch or a backgrounded app cannot step over a level unnoticed.
    func crossedOrders(underlying: String, last: Double) -> [ChartOrder] {
        guard last.isFinite, last > 0 else { return [] }
        let previous = lastPrices[underlying]
        lastPrices[underlying] = last
        return orders.filter { order in
            order.underlying == underlying
                && order.isWorking
                && !firing.contains(order.id)
                && chartOrderCrossed(order, previous: previous ?? order.armPrice, current: last)
        }
    }

    /// Asks the server to fire a line now rather than waiting on the watcher's
    /// next poll. Idempotent server-side, so racing the watcher is harmless.
    func trigger(id: String) async {
        guard !firing.contains(id) else { return }
        firing.insert(id)
        defer { firing.remove(id) }
        do {
            if let updated = ChartOrder(dto: try await apiClient.triggerChartOrder(id: id)) {
                upsert(updated)
            }
            errorMessage = nil
        } catch let error as APIError {
            // The watcher is still armed on this line, so a failed nudge is not
            // the end of the road — surface it and let the server path carry it.
            errorMessage = error.userMessage
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func clearError() {
        errorMessage = nil
    }

    // MARK: - Private

    private func patch(id: String, _ body: ChartOrderPatchDTO) async {
        do {
            if let updated = ChartOrder(dto: try await apiClient.updateChartOrder(id: id, patch: body)) {
                upsert(updated)
            }
            errorMessage = nil
        } catch let error as APIError {
            errorMessage = error.userMessage
            await load() // snap back to the server's view of the line
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func upsert(_ order: ChartOrder) {
        if let index = orders.firstIndex(where: { $0.id == order.id }) {
            orders[index] = order
        } else {
            orders.append(order)
        }
    }

    private func remove(id: String) {
        orders.removeAll { $0.id == id }
        if selectedId == id { selectedId = nil }
    }
}
