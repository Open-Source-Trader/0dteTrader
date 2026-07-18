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
/// and open orders, futures contract selection, flatten/cancel actions.
@MainActor
final class TradeViewModel: ObservableObject {
    // Ticket configuration
    @Published var assetClass: AssetClass = .option
    @Published var quantity = 1
    @Published var orderType: OrderType = .mid

    // Futures selection
    @Published private(set) var futuresRoot: String = FuturesRoots.fallback
    @Published private(set) var futuresContracts: [FuturesContract] = []
    @Published private(set) var futuresError: String?
    @Published var selectedFutureSymbol: String?

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

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    // MARK: - Quantity (FR-18)

    func setQuantity(_ value: Int) {
        // Upper bound mirrors the server's @Max(1000) on OrderRequestDto.
        quantity = min(1000, max(1, value))
    }

    func addQuantity(_ amount: Int) {
        setQuantity(quantity + amount)
    }

    // MARK: - Futures (FR-21)

    func setFuturesRoot(_ root: String) async {
        guard root != futuresRoot || futuresContracts.isEmpty else { return }
        futuresRoot = root
        await loadFuturesContracts()
    }

    /// `silent` suppresses the error toast for background 30s refreshes.
    func loadFuturesContracts(silent: Bool = false) async {
        do {
            let contracts = try await apiClient.futures(root: futuresRoot).map(FuturesContract.init(dto:))
            futuresContracts = contracts
            futuresError = nil
            if selectedFutureSymbol == nil || !contracts.contains(where: { $0.symbol == selectedFutureSymbol }) {
                // Front month by default.
                selectedFutureSymbol = contracts.first(where: \.frontMonth)?.symbol ?? contracts.first?.symbol
            }
        } catch let error as APIError {
            futuresError = error.userMessage
            if !silent { showToast(error.userMessage, style: .error) }
        } catch {
            futuresError = error.localizedDescription
            if !silent { showToast(error.localizedDescription, style: .error) }
        }
    }

    var selectedFuture: FuturesContract? {
        futuresContracts.first { $0.symbol == selectedFutureSymbol }
    }

    /// Live tick for a subscribed contract symbol: updates the matching futures
    /// contract's quote and recomputes any matching position's mark and P/L
    /// (server-provided multiplier keeps the math consistent with the broker).
    func applyContractQuote(_ quote: Quote) {
        if let index = futuresContracts.firstIndex(where: { $0.symbol == quote.symbol }) {
            let old = futuresContracts[index]
            futuresContracts[index] = FuturesContract(
                symbol: old.symbol,
                root: old.root,
                expiration: old.expiration,
                frontMonth: old.frontMonth,
                bid: quote.bid,
                ask: quote.ask,
                last: quote.last
            )
        }
        if let index = positions.firstIndex(where: { $0.symbol == quote.symbol }) {
            var position = positions[index]
            position.markPrice = quote.last
            let pnl = (quote.last - position.avgPrice) * Double(position.quantity) * position.multiplier
            position.unrealizedPnl = (pnl * 100).rounded() / 100
            positions[index] = position
        }
    }

    #if DEBUG
    /// Test hook: futuresContracts is private(set).
    func setFuturesContractsForTesting(_ contracts: [FuturesContract]) {
        futuresContracts = contracts
    }
    #endif

    // MARK: - Arm (step 1 of FR-19)

    /// Builds the OrderRequest, generates the idempotency key, and opens the
    /// confirmation sheet with a server preview.
    func arm(side: OrderSide, underlying: String, chainViewModel: OptionsChainViewModel) {
        let selection: OrderSelectionDTO
        let summary: String
        var requestUnderlying = underlying

        switch assetClass {
        case .option:
            let optionType = chainViewModel.optionType
            if chainViewModel.isAutoMode {
                selection = OrderSelectionDTO(
                    mode: "auto_otm",
                    optionType: optionType.rawValue,
                    expiration: chainViewModel.selectedExpiration,
                    strike: nil,
                    contractSymbol: nil
                )
                let expirationLabel = chainViewModel.selectedExpiration ?? "nearest"
                summary = "\(underlying) AUTO +1 OTM \(optionType.displayName) · exp \(expirationLabel)"
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
                    strike: strike,
                    contractSymbol: nil
                )
                summary = "\(underlying) \(expiration) \(Format.strike(strike))\(optionType.shortName)"
            }

        case .future:
            guard let contract = selectedFuture else {
                showToast("Pick a futures contract first.", style: .error)
                return
            }
            selection = OrderSelectionDTO(
                mode: "explicit",
                optionType: nil,
                expiration: nil,
                strike: nil,
                contractSymbol: contract.symbol
            )
            summary = contract.symbol
            // The charted symbol may be a specific contract ("MESU26"); the
            // server expects the root as the order's underlying.
            requestUnderlying = contract.root
        }

        let request = OrderRequestDTO(
            underlying: requestUnderlying,
            assetClass: assetClass.rawValue,
            side: side.rawValue,
            quantity: quantity,
            orderType: orderType.rawValue,
            selection: selection
        )
        armedTicket = ArmedOrderTicket(
            id: UUID(),
            request: request,
            idempotencyKey: UUID().uuidString,
            side: side,
            summary: summary
        )
        preview = nil
        previewError = nil
        submitError = nil
        Task { await loadPreview() }
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

    /// Submits the armed order. The same idempotency key is reused across
    /// retries, so a double tap or a retried submission posts exactly one order.
    func confirmArmedOrder() async {
        guard let ticket = armedTicket, !isSubmitting else { return }
        isSubmitting = true
        submitError = nil
        defer { isSubmitting = false }
        do {
            let result = OrderResult(dto: try await apiClient.placeOrder(
                ticket.request,
                idempotencyKey: ticket.idempotencyKey
            ))
            armedTicket = nil
            showToast(
                "\(ticket.side.displayName) \(result.contractSymbol) — \(result.status.displayName)",
                style: result.status == .rejected ? .error : .success
            )
            await refreshTradingData()
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

    func refreshTradingData() async {
        do {
            positions = try await apiClient.positions().compactMap(Position.init(dto:))
        } catch let error as APIError {
            showToast(error.userMessage, style: .error)
        } catch {
            showToast(error.localizedDescription, style: .error)
        }
        do {
            openOrders = try await apiClient.openOrders().map(OrderResult.init(dto:))
        } catch let error as APIError {
            showToast(error.userMessage, style: .error)
        } catch {
            showToast(error.localizedDescription, style: .error)
        }
    }

    /// Tap-to-flatten: opposite-side market order for the full position size.
    func flatten(_ position: Position) async {
        guard position.quantity != 0 else { return }
        guard !workingSymbols.contains(position.symbol) else { return }
        workingSymbols.insert(position.symbol)
        defer { workingSymbols.remove(position.symbol) }

        let side: OrderSide = position.quantity > 0 ? .sell : .buy
        let selection: OrderSelectionDTO
        let underlying: String

        switch position.assetClass {
        case .future:
            selection = OrderSelectionDTO(
                mode: "explicit",
                optionType: nil,
                expiration: nil,
                strike: nil,
                contractSymbol: position.symbol
            )
            underlying = FuturesRoots.root(for: position.symbol) ?? futuresRoot

        case .option:
            guard let contract = optionContractResolver?(position.symbol) else {
                showToast("Open \(position.symbol)'s chart to flatten this option.", style: .error)
                return
            }
            selection = OrderSelectionDTO(
                mode: "explicit",
                optionType: contract.optionType.rawValue,
                expiration: contract.expiration,
                strike: contract.strike,
                contractSymbol: nil
            )
            underlying = contract.underlying
        }

        let request = OrderRequestDTO(
            underlying: underlying,
            assetClass: position.assetClass.rawValue,
            side: side.rawValue,
            quantity: abs(position.quantity),
            orderType: OrderType.market.rawValue,
            selection: selection
        )
        do {
            let result = OrderResult(dto: try await apiClient.placeOrder(
                request,
                idempotencyKey: UUID().uuidString
            ))
            showToast(
                "Flatten \(position.symbol) — \(result.status.displayName)",
                style: result.status == .rejected ? .error : .success
            )
            await refreshTradingData()
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
            await refreshTradingData()
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
