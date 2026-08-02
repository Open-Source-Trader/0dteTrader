import Foundation

struct Toast: Equatable, Sendable {
    enum Style: Sendable {
        case success
        case error
        case info
    }

    let id: UUID
    let message: String
    let style: Style

    init(message: String, style: Style) {
        self.id = UUID()
        self.message = message
        self.style = style
    }
}

/// An armed (not yet confirmed) order. The idempotency key is generated when
/// the ticket arms and is reused by every retry/double-tap (PRD FR-19/FR-26).
struct ArmedOrderTicket: Identifiable, Sendable {
    let id: UUID
    let request: OrderRequestDTO
    let idempotencyKey: String
    let side: OrderSide
    let summary: String
}

/// Trade state: ticket configuration, arm-then-confirm order flow, positions
/// and open orders, flatten/cancel actions. Options-only.
@MainActor
final class TradeViewModel: ObservableObject {
    // Ticket configuration
    @Published var quantity = 1
    @Published var orderType: OrderType = .mid
    /// The price a `.custom` order works at, or nil while none has been entered.
    ///
    /// Held here rather than in the field so the arm guard and the confirm sheet
    /// read the same settled number, and so it can be cleared from outside when
    /// the contract it was typed for changes — see `clearCustomLimitPrice`.
    @Published private(set) var customLimitPrice: Double?

    // Positions & orders
    @Published private(set) var positions: [Position] = []
    @Published private(set) var openOrders: [OrderResult] = []
    @Published private(set) var workingSymbols: Set<String> = []

    // Arm-then-confirm flow
    @Published var armedTicket: ArmedOrderTicket?
    @Published private(set) var preview: OrderPreview?
    @Published private(set) var isPreviewLoading = false
    @Published private(set) var previewError: String?
    /// Submission failures, kept separate from preview errors so the confirm
    /// sheet can render each with the correct recovery action.
    @Published private(set) var submitError: String?
    @Published private(set) var isSubmitting = false

    @Published private(set) var toast: Toast?

    private let apiClient: APIClient
    private var toastDismissTask: Task<Void, Never>?

    /// Resolves an option position's contract symbol to chain data so a flatten
    /// order can be built as explicit option selection. Wired by the trade screen
    /// to the OptionsChainViewModel's loaded chain.
    var optionContractResolver: ((String) -> OptionContract?)?

    /// Reports whether the order-update socket is currently connected. An
    /// order placement's own `orderUpdate` push (submitted, then the terminal
    /// status) drives `handleOrderUpdate` → `refreshTradingData` already, so a
    /// direct refresh after placing/cancelling is only needed as a fallback
    /// for when that push has nowhere to arrive. Wired from the trade screen;
    /// nil (treated as disconnected) only in previews/tests.
    var isSocketConnected: (() -> Bool)?

    /// Gates success/info toasts (Profile → in-app toasts). Error toasts
    /// always show regardless. Nil (previews/tests) means show everything.
    var toastPolicy: (() -> Bool)?

    /// Coalesces concurrent refreshes: an order placement's submitted and
    /// terminal-status pushes can each trigger one in quick succession, so a
    /// call already running is awaited rather than duplicated, with at most
    /// one more queued to pick up anything that arrived meanwhile.
    private var refreshInFlight: Task<Void, Never>?
    private var refreshQueued = false

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    #if DEBUG
    /// Seeds positions without a network round trip (tests only).
    func setPositionsForTesting(_ positions: [Position]) {
        self.positions = positions
    }

    /// Seeds a resolved preview without a network round trip (tests only), so
    /// the confirm popup can be measured in the state it actually ships in —
    /// spread, warnings and all.
    func setPreviewForTesting(_ preview: OrderPreview) {
        self.preview = preview
    }
    #endif

    // MARK: - Quantity (FR-18)

    func setQuantity(_ value: Int) {
        // Upper bound mirrors the server's @Max(1000) on OrderRequestDto.
        quantity = min(1000, max(1, value))
    }

    func addQuantity(_ amount: Int) {
        setQuantity(quantity + amount)
    }

    // MARK: - Custom limit price

    /// The settled custom limit, or nil while the field does not name a price.
    /// Rounded to the cent the contract is quoted at — the server rejects
    /// anything finer.
    func setCustomLimitPrice(_ price: Double?) {
        customLimitPrice = price.map { ($0 * 100).rounded() / 100 }
    }

    /// Drops a custom price and the selection that would send it, called when
    /// the contract underneath changes.
    ///
    /// A premium is only meaningful for the contract it was typed against —
    /// 2.45 is near the money on one strike and ten times the ask on the next —
    /// so carrying it silently onto a different contract is the one way this
    /// feature could fill an order nobody meant. Falling back to `.mid` rather
    /// than merely blanking the field also moves the highlight, so the change
    /// is visible rather than a field that quietly emptied.
    func clearCustomLimitPrice() {
        guard customLimitPrice != nil || orderType == .custom else { return }
        customLimitPrice = nil
        if orderType == .custom { orderType = .mid }
    }

    /// Whether the pricing selection is complete enough to arm. `.custom` with
    /// nothing typed has no price to send, and the server would refuse it.
    var canArm: Bool { orderType != .custom || customLimitPrice != nil }

    /// Live tick for a subscribed contract symbol: recomputes any matching
    /// position's mark and P/L (server-provided multiplier keeps the math
    /// consistent with the broker).
    func applyContractQuote(_ quote: Quote) {
        if let index = positions.firstIndex(where: { $0.symbol == quote.symbol }) {
            var position = positions[index]
            position.markPrice = quote.last
            let pnl = (quote.last - position.avgPrice) * Double(position.quantity) * position.multiplier
            position.unrealizedPnl = (pnl * 100).rounded() / 100
            positions[index] = position
        }
    }

    // MARK: - Arm (step 1 of FR-19)

    /// Builds the OrderRequest and generates the idempotency key. Normally opens
    /// the confirmation sheet with a server preview; when `bypass` is set
    /// (Profile → Skip order confirmation) it submits immediately, skipping the
    /// sheet.
    func arm(side: OrderSide, underlying: String, chainViewModel: OptionsChainViewModel, bypass: Bool = false) {
        let selection: OrderSelectionDTO
        let summary: String
        let optionType = chainViewModel.optionType

        // Sent only for `.custom`; the server rejects it alongside any other
        // variant, because those four are priced from its own quote.
        let limitPrice = orderType == .custom ? customLimitPrice : nil
        if orderType == .custom, limitPrice == nil {
            showToast("Enter a limit price first.", style: .error)
            return
        }

        // Selling closes (part of) a held position rather than opening a short
        // when the UI's selected right (put/call) and expiration match a held
        // position — regardless of which strike AUTO mode currently points at.
        // Matching on strike would miss a held position whenever AUTO's live
        // OTM pick has drifted off the strike actually held, silently routing
        // the sell through the open-order path below and stacking a naked
        // position on top of the one the user meant to close (the bug this
        // guards against). Legs are resolved through `optionContractResolver`
        // rather than trusted from the chain's `selectedContract`, since that
        // is exactly the drifted AUTO pick we cannot use for the close's strike.
        // CURR mode skips this entirely: its selection IS a held contract, so
        // the drift this rescues cannot happen and the explicit pick must win.
        if side == .sell, !chainViewModel.isCurrMode,
           let expiration = chainViewModel.selectedExpiration,
           case let heldLegs = positions.compactMap({ position -> (Position, OptionContract)? in
               guard position.quantity > 0,
                     let contract = optionContractResolver?(position.symbol),
                     contract.underlying == underlying,
                     contract.expiration == expiration,
                     contract.optionType == optionType
               else { return nil }
               return (position, contract)
           }),
           !heldLegs.isEmpty {
            // Highest unrealized P/L first: scale out of the most profitable
            // leg before touching the rest when the ticket doesn't cover the
            // full combined size.
            let ordered = heldLegs.sorted { $0.0.unrealizedPnl > $1.0.unrealizedPnl }
            let totalHeld = ordered.reduce(0) { $0 + $1.0.quantity }
            var remaining = min(quantity, totalHeld)
            var closes: [(contract: OptionContract, quantity: Int)] = []
            for (position, contract) in ordered where remaining > 0 {
                let take = min(remaining, position.quantity)
                closes.append((contract, take))
                remaining -= take
            }

            // One order per arm: only the highest-P/L leg closes on this tap.
            // When the ticket spans multiple strikes, the summary says "of
            // <total>" so the user sees the remainder is untouched and can
            // tap SELL again to work through the rest, rather than the ticket
            // silently closing only part of the intended size.
            guard let firstClose = closes.first else { return }
            let closeQuantity = firstClose.quantity
            let sizeLabel = closeQuantity < totalHeld
                ? "\(closeQuantity) of \(totalHeld)"
                : "\(closeQuantity)"
            let request = OrderRequestDTO(
                underlying: underlying,
                assetClass: "option",
                side: side.rawValue,
                quantity: closeQuantity,
                orderType: orderType.rawValue,
                limitPrice: limitPrice,
                selection: OrderSelectionDTO(
                    mode: "explicit",
                    optionType: firstClose.contract.optionType.rawValue,
                    expiration: firstClose.contract.expiration,
                    strike: firstClose.contract.strike
                )
            )
            armedTicket = ArmedOrderTicket(
                id: UUID(),
                request: request,
                idempotencyKey: UUID().uuidString,
                side: side,
                summary: "CLOSE \(sizeLabel) · \(underlying) "
                    + "\(Format.strike(firstClose.contract.strike))\(firstClose.contract.optionType.shortName)"
            )
            preview = nil
            previewError = nil
            submitError = nil
            Task { await loadPreview() }
            return
        }

        // A sell that matched nothing above has nothing to close. Refuse it:
        // falling through would open a short nobody asked for.
        if side == .sell, !chainViewModel.isCurrMode {
            showToast("No open position to sell", style: .error)
            return
        }

        var orderQuantity = quantity
        if chainViewModel.isCurrMode {
            // CURR: the ticket names a held contract explicitly. Buys add to
            // it; sells close part of it, clamped so a sell can never pass
            // through zero into a short.
            guard let contract = chainViewModel.selectedContract else {
                showToast("Pick a held contract first.", style: .error)
                return
            }
            selection = OrderSelectionDTO(
                mode: "explicit",
                optionType: contract.optionType.rawValue,
                expiration: contract.expiration,
                strike: contract.strike
            )
            let leg = "\(Format.strike(contract.strike))\(contract.optionType.shortName)"
            if side == .sell {
                let held = positions.first { $0.symbol == contract.symbol && $0.quantity > 0 }?.quantity ?? 0
                guard held > 0 else {
                    showToast("No open position to sell", style: .error)
                    return
                }
                orderQuantity = min(quantity, held)
                let sizeLabel = orderQuantity < held ? "\(orderQuantity) of \(held)" : "\(orderQuantity)"
                summary = "CLOSE \(sizeLabel) · \(underlying) \(leg)"
            } else {
                summary = "\(underlying) \(contract.expiration) \(leg)"
            }
        } else if chainViewModel.isAutoMode {
            let offset = chainViewModel.autoOtmOffset
            selection = OrderSelectionDTO(
                mode: "auto_otm",
                optionType: optionType.rawValue,
                expiration: chainViewModel.selectedExpiration,
                strike: nil,
                // Omitted at the default so servers predating the field see
                // the request shape they always did (they resolve +1 anyway).
                otmOffset: offset == 1 ? nil : offset
            )
            let expirationLabel = chainViewModel.selectedExpiration ?? "nearest"
            let offsetLabel = offset == 0 ? "ATM" : "+\(offset) OTM"
            summary = "\(underlying) AUTO \(offsetLabel) \(optionType.displayName) · exp \(expirationLabel)"
        } else {
            guard let strike = chainViewModel.selectedStrike,
                  let expiration = chainViewModel.selectedExpiration
            else {
                showToast("Pick an expiration and strike first.", style: .error)
                return
            }
            selection = OrderSelectionDTO(
                mode: "explicit",
                optionType: optionType.rawValue,
                expiration: expiration,
                strike: strike
            )
            summary = "\(underlying) \(expiration) \(Format.strike(strike))\(optionType.shortName)"
        }

        let request = OrderRequestDTO(
            underlying: underlying,
            assetClass: "option",
            side: side.rawValue,
            quantity: orderQuantity,
            orderType: orderType.rawValue,
            limitPrice: limitPrice,
            selection: selection
        )
        let idempotencyKey = UUID().uuidString
        if bypass {
            // Clear any stale ticket/preview state before bypassing
            armedTicket = nil
            preview = nil
            previewError = nil
            submitError = nil
            Task { await placeDirect(request, idempotencyKey: idempotencyKey, side: side) }
            return
        }
        armedTicket = ArmedOrderTicket(
            id: UUID(),
            request: request,
            idempotencyKey: idempotencyKey,
            side: side,
            summary: summary
        )
        preview = nil
        previewError = nil
        submitError = nil
        Task { await loadPreview() }
    }

    /// Submits without the confirm sheet (bypass path). Failures surface as a
    /// toast since there is no sheet to hold a submit error.
    private func placeDirect(_ request: OrderRequestDTO, idempotencyKey: String, side: OrderSide) async {
        guard !isSubmitting else { return }
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            try await submitOrder(request, idempotencyKey: idempotencyKey, side: side)
        } catch let error as APIError {
            showToast(error.userMessage, style: .error)
        } catch {
            showToast(error.localizedDescription, style: .error)
        }
    }

    /// Server-side preview powering the confirmation sheet (resolved contract + price).
    func loadPreview() async {
        guard let ticket = armedTicket else { return }
        isPreviewLoading = true
        previewError = nil
        defer { isPreviewLoading = false }
        do {
            let dto = try await apiClient.previewOrder(ticket.request)
            preview = OrderPreview(dto: dto)
        } catch let error as APIError {
            previewError = error.userMessage
        } catch {
            previewError = error.localizedDescription
        }
    }

    // MARK: - Confirm (step 2 of FR-19)

    /// Places the order, clears the armed ticket, and toasts the result.
    /// Throws so callers surface the error their own way (sheet submit error
    /// vs. toast). Shared by the confirm and bypass paths.
    ///
    /// Skips its own refresh when the socket is connected: the placement's own
    /// `orderUpdate` push (submitted, then the terminal fill/reject) arrives
    /// over the same socket and drives `handleOrderUpdate` →
    /// `refreshTradingData` already, so refreshing here too only stacked a
    /// redundant reload on top of it. Falls back to a direct refresh when the
    /// socket is down and that push has nowhere to arrive.
    private func submitOrder(_ request: OrderRequestDTO, idempotencyKey: String, side: OrderSide) async throws {
        let result = OrderResult(dto: try await apiClient.placeOrder(
            request,
            idempotencyKey: idempotencyKey
        ))
        armedTicket = nil
        showToast(
            "\(side.displayName) \(result.contractSymbol) — \(result.status.displayName)",
            style: result.status == .rejected ? .error : .success
        )
        if isSocketConnected?() != true {
            await refreshTradingData()
        }
    }

    /// Submits the armed order. The same idempotency key is reused across
    /// retries, so a double tap or a retried submission posts exactly one order.
    func confirmArmedOrder() async {
        guard let ticket = armedTicket, !isSubmitting else { return }
        isSubmitting = true
        submitError = nil
        defer { isSubmitting = false }
        do {
            try await submitOrder(ticket.request, idempotencyKey: ticket.idempotencyKey, side: ticket.side)
        } catch let error as APIError {
            // Keep the ticket armed so the user can retry with the same key.
            submitError = error.userMessage
        } catch {
            submitError = error.localizedDescription
        }
    }

    func cancelArmedOrder() {
        armedTicket = nil
        submitError = nil
    }

    // MARK: - Positions & open orders (FR-23..25)

    /// A single order placement can emit a submitted push and a terminal
    /// fill/reject push in quick succession, each wired to call this — so
    /// calls collapse: one already running is awaited rather than duplicated,
    /// and at most one more runs after it to pick up anything that arrived
    /// meanwhile.
    func refreshTradingData() async {
        if let inFlight = refreshInFlight {
            refreshQueued = true
            return await inFlight.value
        }
        let task = Task { await runRefresh() }
        refreshInFlight = task
        await task.value
        refreshInFlight = nil
        if refreshQueued {
            refreshQueued = false
            await refreshTradingData()
        }
    }

    private func runRefresh() async {
        async let positionsResult = catching { try await apiClient.positions() }
        async let openOrdersResult = catching { try await apiClient.openOrders() }

        switch await positionsResult {
        case let .success(dtos):
            positions = dtos.compactMap(Position.init(dto:))
        case let .failure(error as APIError):
            showToast(error.userMessage, style: .error)
        case let .failure(error):
            showToast(error.localizedDescription, style: .error)
        }
        switch await openOrdersResult {
        case let .success(dtos):
            openOrders = dtos.map(OrderResult.init(dto:))
        case let .failure(error as APIError):
            showToast(error.userMessage, style: .error)
        case let .failure(error):
            showToast(error.localizedDescription, style: .error)
        }
    }

    /// `Result.init(catching:)` has no `async` overload; this fills that gap
    /// so `positions()`/`openOrders()` can run concurrently via `async let`
    /// while each keeps its own independent success/failure outcome.
    private func catching<T>(_ body: () async throws -> T) async -> Result<T, Error> {
        do {
            return .success(try await body())
        } catch {
            return .failure(error)
        }
    }

    /// Tap-to-flatten: opposite-side market order for the full position size.
    func flatten(_ position: Position) async {
        await exit(position, quantity: abs(position.quantity), action: "Flatten")
    }

    /// Partial scale-out: opposite-side market order for half the position.
    /// Rounds down, like the desktop's `TradeStore.trimHalf` — a 1-lot has
    /// nothing to trim, so it no-ops.
    func trimHalf(_ position: Position) async {
        await exit(position, quantity: Self.trimQuantity(position.quantity), action: "Trim")
    }

    /// Half the position, rounded down — the quantity `trimHalf` sends.
    nonisolated static func trimQuantity(_ positionQuantity: Int) -> Int {
        abs(positionQuantity) / 2
    }

    /// Opposite-side market order reducing `position` by `quantity`
    /// (clamped to the position size). Shared by flatten and trimHalf.
    private func exit(_ position: Position, quantity: Int, action: String) async {
        guard position.quantity != 0, quantity > 0 else { return }
        guard !workingSymbols.contains(position.symbol) else { return }

        guard let contract = optionContractResolver?(position.symbol) else {
            showToast("Open \(position.symbol)'s chart to flatten this option.", style: .error)
            return
        }
        workingSymbols.insert(position.symbol)
        defer { workingSymbols.remove(position.symbol) }

        let side: OrderSide = position.quantity > 0 ? .sell : .buy
        let request = OrderRequestDTO(
            underlying: contract.underlying,
            assetClass: "option",
            side: side.rawValue,
            quantity: min(quantity, abs(position.quantity)),
            orderType: OrderType.market.rawValue,
            limitPrice: nil,
            selection: OrderSelectionDTO(
                mode: "explicit",
                optionType: contract.optionType.rawValue,
                expiration: contract.expiration,
                strike: contract.strike
            )
        )
        do {
            let result = OrderResult(dto: try await apiClient.placeOrder(
                request,
                idempotencyKey: UUID().uuidString
            ))
            showToast(
                "\(action) \(position.symbol) — \(result.status.displayName)",
                style: result.status == .rejected ? .error : .success
            )
            // See submitOrder: the placement's own orderUpdate push refreshes
            // when the socket is up; fall back to a direct refresh when it's not.
            if isSocketConnected?() != true {
                await refreshTradingData()
            }
        } catch let error as APIError {
            showToast(error.userMessage, style: .error)
        } catch {
            showToast(error.localizedDescription, style: .error)
        }
    }

    func cancel(_ order: OrderResult) async {
        do {
            try await apiClient.cancelOrder(orderId: order.orderId)
            showToast("Order cancelled.", style: .info)
            // See submitOrder: cancelOrder's own orderUpdate push refreshes
            // when the socket is up; fall back to a direct refresh when it's not.
            if isSocketConnected?() != true {
                await refreshTradingData()
            }
        } catch let error as APIError {
            showToast(error.userMessage, style: .error)
        } catch {
            showToast(error.localizedDescription, style: .error)
        }
    }

    // MARK: - WS order updates

    func handleOrderUpdate(_ update: OrderResult) {
        showToast(
            "Order \(update.contractSymbol) — \(update.status.displayName)",
            style: update.status == .rejected ? .error : .info
        )
        Task { await refreshTradingData() }
    }

    // MARK: - Toast

    /// Toasts waiting behind the one on screen; drained in order so rapid
    /// order-status events don't silently replace each other.
    private var toastQueue: [Toast] = []

    func showToast(_ message: String, style: Toast.Style) {
        // Errors always surface; only the routine chatter is gated.
        if style != .error, toastPolicy?() == false { return }
        let toast = Toast(message: message, style: style)
        if style == .success {
            Haptics.success()
        } else if style == .error {
            Haptics.error()
        }
        toastQueue.append(toast)
        guard self.toast == nil else { return }
        showNextToast()
    }

    /// Manual dismiss (tap on the toast capsule): drops the visible toast and
    /// drains the queue.
    func dismissCurrentToast() {
        toastDismissTask?.cancel()
        if let current = toast {
            toastQueue.removeAll { $0.id == current.id }
        }
        toast = nil
        scheduleNextToast()
    }

    private func showNextToast() {
        guard let next = toastQueue.first else { return }
        toast = next
        toastDismissTask?.cancel()
        // Errors carry longer API messages and stay up longer to stay readable.
        let duration: UInt64 = next.style == .error ? 5_000_000_000 : 3_000_000_000
        toastDismissTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: duration)
            guard let self, !Task.isCancelled else { return }
            self.toastQueue.removeAll { $0.id == next.id }
            self.toast = nil
            self.scheduleNextToast()
        }
    }

    private func scheduleNextToast() {
        toastDismissTask = Task { [weak self] in
            // Let the exit transition finish before the next toast enters.
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard let self, !Task.isCancelled else { return }
            self.showNextToast()
        }
    }
}
