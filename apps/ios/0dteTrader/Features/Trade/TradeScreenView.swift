import SwiftUI

/// The main screen (PRD §3.3):
/// - Layout A (fullscreen): chart fills the screen, floating Buy/Sell overlaid.
/// - Layout B (split): chart on top, trade panel below; panel height auto-adjusts
///   based on how many indicator sub-panes are enabled (desktop parity).
/// Layout choice persists (FR-12).
struct TradeScreenView: View {
    let container: AppContainer
    let onLogout: () async -> Void

    @StateObject private var chartViewModel: ChartViewModel
    @StateObject private var chainViewModel: OptionsChainViewModel
    @StateObject private var tradeViewModel: TradeViewModel
    @StateObject private var profileViewModel: ProfileViewModel
    @StateObject private var chartOrdersModel: ChartOrdersModel
    @StateObject private var chartTrading: ChartTradingCoordinator

    /// The screen's one anchored-popup slot. Owned here because every chip
    /// that opens one — the ticker and interval on the chart, the expiration
    /// and strike in the panel — sits inside something that clips, and the slot
    /// has to be declared above all of them.
    @StateObject private var hudMenus = HudMenuController()

    @State private var layout: TradeLayout
    @State private var tradingLocked: Bool
    /// The TWC script's own screen. It was a `NavigationLink` inside the
    /// indicator form; the form is a dropdown now, which has no navigation
    /// stack, so the gear closes the popup and raises this instead — the same
    /// arrangement the desktop already used.
    @State private var showTwcSettings = false
    @State private var showProfile = false
    @State private var showHistory = false
    @State private var showAIAnalysis = false
    // 'nil' until /v1/me answers; the server value wins (desktop parity).
    @State private var tradingMode: TradingMode?
    @State private var me: MeDTO?
    @State private var showModeConfirmation = false
    /// Where the trade panel's pricing row sits inside the panel while its
    /// custom-price field holds the keyboard, and nil the rest of the time.
    /// That field is the one on this screen the keys would cover, and so the
    /// one thing that makes the panel move. See `layoutContent`.
    @State private var editingPriceRowBottom: CGFloat?
    @State private var tradePanelHeight: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private let settingsStore: SettingsStore

    init(container: AppContainer, onLogout: @escaping () async -> Void) {
        self.container = container
        self.onLogout = onLogout
        _chartViewModel = StateObject(wrappedValue: container.makeChartViewModel())
        _chainViewModel = StateObject(wrappedValue: container.makeOptionsChainViewModel())
        _tradeViewModel = StateObject(wrappedValue: container.makeTradeViewModel())
        _profileViewModel = StateObject(wrappedValue: container.makeProfileViewModel(onLogout: onLogout))
        let chartOrders = container.makeChartOrdersModel()
        _chartOrdersModel = StateObject(wrappedValue: chartOrders)
        _chartTrading = StateObject(
            wrappedValue: container.makeChartTradingCoordinator(chartOrders: chartOrders)
        )
        _layout = State(initialValue: container.settingsStore.layoutMode)
        _tradingLocked = State(initialValue: container.settingsStore.tradingLocked)
        self.settingsStore = container.settingsStore
    }

    var body: some View {
        NavigationStack {
            layoutContent
                .background(Color.appBackground)
                .overlay(alignment: .top) {
                    VStack(spacing: 8) {
                        if needsProviderConfig {
                            providerConfigBanner
                        }
                        if let toast = tradeViewModel.toast {
                            ToastView(toast: toast, onDismiss: { tradeViewModel.dismissCurrentToast() })
                                                .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
                                                .zIndex(1)
                        }
                    }
                    .padding(.top, AppSpacing.sm)
                }
                .animation(AppMotion.standard, value: tradeViewModel.toast)
                // The wordmark, the profile button and the history button all
                // live in the chart header now, so there is nothing left for a
                // navigation bar to carry — hidden rather than emptied, or it
                // would keep reserving 44pt of the chart's height.
                .toolbar(.hidden, for: .navigationBar)
        }
        // Last, so the popups draw over the chart, the panel and the toasts,
        // and nothing above them clips.
        .hudMenuHost(hudMenus)
        .modifier(
            OptionsAnalyticsLifecycleModifier(
                viewModel: chartViewModel,
                scenePhase: scenePhase
            )
        )
        .modifier(
            OrderConfirmPresentation(tradeViewModel: tradeViewModel, hudMenus: hudMenus)
        )
        // Closing a position and cancelling a working line both confirm first:
        // the first sends a real market order, and the second cannot be undone.
        .alert(
            "Close position?",
            isPresented: Binding(
                get: { chartTrading.positionPendingFlatten != nil },
                set: { if !$0 { chartTrading.positionPendingFlatten = nil } }
            ),
            presenting: chartTrading.positionPendingFlatten
        ) { position in
            Button("Close \(position.symbol)", role: .destructive) {
                chartTrading.confirmFlatten()
            }
            Button("Cancel", role: .cancel) {}
        } message: { position in
            Text("Sends a market order to close \(position.symbol). Only this contract is closed.")
        }
        .alert(
            "Cancel order line?",
            isPresented: Binding(
                get: { chartTrading.orderPendingCancel != nil },
                set: { if !$0 { chartTrading.orderPendingCancel = nil } }
            ),
            presenting: chartTrading.orderPendingCancel
        ) { _ in
            Button("Cancel line", role: .destructive) { chartTrading.confirmCancel() }
            Button("Keep", role: .cancel) {}
        } message: { order in
            Text(
                "Removes the \(order.kind.shortLabel) line at \(Format.price(order.triggerPrice)). "
                    + "Nothing was sent to the broker."
            )
        }
        .sheet(isPresented: $showTwcSettings) {
            NavigationStack {
                TwcSettingsView(settings: $chartViewModel.twcSettings)
                    // Presented rather than pushed now, so it needs a way out
                    // of its own where the navigation stack used to give it a
                    // back button.
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Done") { showTwcSettings = false }
                        }
                    }
            }
            // Sheets sit outside the root window's tree, so `RootView`'s
            // tap/swipe keyboard dismissal does not reach them — each sheet
            // with a field carries its own.
            .dismissKeyboardOnInteraction()
        }
        .sheet(isPresented: $showProfile, onDismiss: {
            Task { await refreshTradingContext() }
        }) {
            ProfileView(viewModel: profileViewModel)
                .dismissKeyboardOnInteraction()
        }
        .sheet(isPresented: $showHistory) {
            HistoryView(apiClient: container.apiClient)
        }
        .sheet(isPresented: $showAIAnalysis) {
            #if canImport(FoundationModels)
            if #available(iOS 26, *) {
                AIAnalysisSheet(
                    chartViewModel: chartViewModel,
                    chainViewModel: chainViewModel
                )
            }
            #endif
        }
        .task {
            await chartViewModel.start()
        }
        .task {
            if let fetched = try? await container.apiClient.me() {
                tradingMode = fetched.tradingMode ?? .practice
                me = fetched
                // The session is proven valid at this point. If the initial
                // candle load raced login (or failed before auth settled), the
                // chart would sit empty until the user jiggles tickers — reload
                // the CURRENT symbol instead.
                if chartViewModel.candles.isEmpty, !chartViewModel.isLoading {
                    await chartViewModel.start()
                }
            }
        }
        .confirmationDialog(
            "Switch to \(tradingMode == .live ? "practice" : "LIVE") trading?",
            isPresented: $showModeConfirmation,
            titleVisibility: .visible
        ) {
            Button(
                tradingMode == .live ? "Switch to Practice" : "Switch to LIVE",
                role: tradingMode == .live ? nil : .destructive
            ) {
                Task { await switchTradingMode() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Orders will route to the \(tradingMode == .live ? "practice" : "LIVE") \(providerName) environment.")
        }
        .task {
            await tradeViewModel.refreshTradingData()
        }
        .task {
            // Keep indicative chain quotes fresh; paused while the confirm
            // sheet is open so the armed ticket's context doesn't shift
            // underneath it.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                guard !Task.isCancelled else { break }
                if tradeViewModel.armedTicket == nil {
                    await chainViewModel.refresh()
                }
            }
        }
        .onAppear {
            // The one place push registration begins: this screen only
            // appears authenticated, so the manager can sweep any retained
            // registration with credentials that work and then re-register
            // under THIS account. A login after a logout reaches here without
            // relaunching the app.
            container.pushNotifications.activateAfterAuthentication()
            tradeViewModel.optionContractResolver = { symbol in
                chainViewModel.chain?.contracts.first { $0.symbol == symbol }
            }
            // CURR mode filters the chain's menus to held contracts.
            chainViewModel.positionsProvider = { tradeViewModel.positions }
            tradeViewModel.toastPolicy = { settingsStore.toastsEnabled }
            // The overlay needs the same chain lookup the flatten path uses:
            // an entry line only draws for a contract the chain can identify.
            chartTrading.contractResolver = { symbol in
                chainViewModel.chain?.contracts.first { $0.symbol == symbol }
            }
            chartTrading.selectedContract = { chainViewModel.selectedContract }
            // Narrowed here, at the one seam where the panel's five-way
            // pricing meets the chart's two-way. A line fires unattended, so
            // `.custom`/`.bid`/`.ask` collapse onto the server-computed mid.
            chartTrading.defaultOrderType = { tradeViewModel.orderType.chartOrderType }
            chartTrading.onFlattenConfirmed = { position in
                Task { await tradeViewModel.flatten(position) }
            }
            // Per-message delivery: rapid updates must not coalesce in a
            // single @Published slot. Re-read after replay catch-up as a cheap
            // consistency check; refresh calls coalesce with these callbacks.
            container.quoteSocket.onReconnected = { [weak chartOrdersModel, weak tradeViewModel] in
                Task {
                    await chartOrdersModel?.load()
                    await tradeViewModel?.refreshTradingData()
                }
            }
            container.quoteSocket.onOrderUpdate = { [weak tradeViewModel] update in
                tradeViewModel?.handleOrderUpdate(update)
            }
            container.quoteSocket.onChartOrder = { [weak chartOrdersModel, weak tradeViewModel] order in
                chartOrdersModel?.applyServerUpdate(order)
                // A fired line means a real order went out — refresh positions
                // so the entry line appears without waiting for the next poll.
                if order.status == .triggered || order.status == .failed {
                    Task { await tradeViewModel?.refreshTradingData() }
                }
            }
            chartOrdersModel.setSymbol(chartViewModel.symbol)
            Task { await chainViewModel.load(underlying: chartViewModel.symbol) }
            Task { await chartOrdersModel.load() }
            container.quoteSocket.subscribe(symbols: watchedContractSymbols)
        }
        .onChange(of: chartViewModel.symbol) { _, newSymbol in
            Task { await chainViewModel.load(underlying: newSymbol) }
            chartOrdersModel.setSymbol(newSymbol)
        }
        .onChange(of: chainViewModel.selectedExpiration) { _, expiration in
            chartViewModel.optionsAnalyticsExpiration = expiration
        }
        // The chain stays live below the chart in the split layout, so the
        // contract an open placement card names can be changed out from under
        // it. Close the card rather than let it arm a contract it is not
        // showing.
        .onChange(of: chainViewModel.selectedContract?.symbol) { _, _ in
            chartTrading.dismissPlacementIfContractChanged()
            // A typed premium belongs to the contract it was typed against, so
            // it is dropped rather than carried onto a different one. Keyed on
            // the symbol, which covers a strike change, an expiration change
            // and AUTO repicking alike.
            tradeViewModel.clearCustomLimitPrice()
        }
        .onChange(of: chartViewModel.alertNotice) { _, notice in
            if let notice {
                let style: Toast.Style = notice.message.lowercased().contains("credentials") ? .error : .info
                tradeViewModel.showToast(notice.message, style: style)
            }
        }
        .onChange(of: chartViewModel.quote) { _, quote in
            // Keep AUTO's reference price live instead of the chain-load snapshot.
            if let quote, quote.symbol == chainViewModel.underlying {
                chainViewModel.underlyingLast = quote.last
            }
            // Chart order lines fire off the same tick. The model nudges the
            // server, which is also polling — the shared idempotency key makes
            // that a race with one winner rather than two orders.
            if let quote {
                for order in chartOrdersModel.crossedOrders(
                    underlying: quote.symbol,
                    last: quote.last
                ) {
                    Task { await chartOrdersModel.trigger(id: order.id) }
                }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            // Coming back from background: iOS can tear the socket down without
            // a close ever arriving, so anything the watcher pushed meanwhile is
            // lost. These lines arm real orders — re-read them.
            guard phase == .active else { return }
            container.quoteSocket.reconnectIfNeeded()
            Task { await chartOrdersModel.load() }
        }
        .onChange(of: chartOrdersModel.errorMessage) { _, message in
            if let message {
                tradeViewModel.showToast(message, style: .error)
                chartOrdersModel.clearError()
            }
        }
        .onChange(of: container.quoteSocket.lastQuote) { _, quote in
            // Contract-symbol ticks: live option quotes and position P/L.
            if let quote {
                chainViewModel.applyContractQuote(quote)
                tradeViewModel.applyContractQuote(quote)
            }
        }
        .onChange(of: watchedContractSymbols) { old, new in
            let removed = Set(old).subtracting(new)
            let added = Set(new).subtracting(old)
            if !removed.isEmpty { container.quoteSocket.unsubscribe(symbols: Array(removed)) }
            if !added.isEmpty { container.quoteSocket.subscribe(symbols: Array(added)) }
        }
    }

    // MARK: - Layouts

    /// The lower ticket is intrinsic-height now; the chart is the only row that
    /// flexes. Density still tightens controls as indicator panes reduce the
    /// chart's useful vertical space.
    private static let panelDensities: [TradePanelDensity] = [.compact, .dense, .dense]
    private static let chartMinHeight: CGFloat = 180

    private var paneCount: Int {
        chartViewModel.indicatorSettings.enabledSubPaneCount
    }

    @ViewBuilder
    private var layoutContent: some View {
        // One reader for both layouts. Bottom safe-area ownership is handled by
        // `.safeAreaInset(edge: .bottom)` below, so the content receives the
        // dock's reserved height and the chart shrinks naturally.
        GeometryReader { geometry in
            switch layout {
            case .fullscreen:
                // Layout A — FR-10.
                ZStack(alignment: .bottom) {
                    chartView
                    VStack(spacing: AppSpacing.sm) {
                        positionsStrip
                        OrderContextStripView(
                            selectedContract: chainViewModel.selectedContract,
                            positions: tradeViewModel.positions,
                            quantity: tradeViewModel.quantity,
                            orderType: tradeViewModel.orderType,
                            customLimitPrice: tradeViewModel.customLimitPrice,
                            isQuoteLoading: chainViewModel.isLoading,
                            warning: chainViewModel.errorMessage ?? optionsWarning,
                            onRetryWarning: chainViewModel.errorMessage == nil ? nil : retryOptionsWarning
                        )
                        .padding(.horizontal, AppSpacing.xl)
                    }
                    .background(
                        LinearGradient(colors: [.clear, Color.appBackground],
                                       startPoint: .top, endPoint: .bottom)
                    )
                    // These are siblings of the chart in this ZStack, so they
                    // sit *above* the placement card living inside it. Left
                    // visible they would leave BUY/SELL tappable through a
                    // supposedly modal order card — the worst version of the
                    // z-order bug. Hidden rather than merely inert, so nothing
                    // paints over the card either.
                    .opacity(chartTrading.placementRequest == nil ? 1 : 0)
                    .allowsHitTesting(chartTrading.placementRequest == nil)
                    .accessibilityHidden(chartTrading.placementRequest != nil)
                }

            case .split:
                // Layout B — one explicit vertical flow. The ticket owns its
                // intrinsic height and bottom safe area; the chart takes the
                // remaining flexible space and yields first on shorter screens.
                let density = Self.panelDensities[min(paneCount, Self.panelDensities.count - 1)]
                VStack(spacing: 0) {
                    chartView
                        .frame(minHeight: Self.chartMinHeight, maxHeight: .infinity)
                        .layoutPriority(0)
                    // The chart card and the trade panel are each already read
                    // as a surface — the card by its border, the panel by the
                    // controls filling it — so a rule between them was drawing
                    // a seam nobody needed. Kept as an empty 1pt gap rather
                    // than deleted: reclaiming it would move the split by a
                    // point for no reason.
                    Color.clear
                        .frame(height: 1)
                    TradePanelView(
                        tradeViewModel: tradeViewModel,
                        chainViewModel: chainViewModel,
                        underlying: chartViewModel.symbol,
                        positionsStrip: positionsStrip,
                        density: density,
                        tradingLocked: tradingLocked || needsProviderConfig,
                        onArm: { side in
                            tradeViewModel.arm(
                                side: side,
                                underlying: chartViewModel.symbol,
                                chainViewModel: chainViewModel,
                                bypass: settingsStore.bypassOrderConfirmation
                            )
                        },
                        onToggleLock: { toggleLock() },
                        onShowAIAnalysis: { showAIAnalysis = true },
                        optionsWarning: optionsWarning,
                        onRetryOptionsWarning: retryOptionsWarning,
                        editingRowBottomInPanel: $editingPriceRowBottom
                    )
                    .fixedSize(horizontal: false, vertical: true)
                    .background {
                        GeometryReader { proxy in
                            Color.clear
                                .onAppear { tradePanelHeight = proxy.size.height }
                                .onChange(of: proxy.size.height) { _, height in tradePanelHeight = height }
                        }
                    }
                    // Swipe left (or tap the chevron) for the positions drawer.
                    .modifier(PositionsPanelPresentation(
                        tradeViewModel: tradeViewModel,
                        chartOrders: chartOrdersModel,
                        tradingLocked: tradingLocked || needsProviderConfig
                    ))
                    .layoutPriority(1)
                    // Drawn offset, not layout: the panel slides up over the
                    // chart just far enough to bring the price field clear of
                    // the keys. The dock remains part of normal layout and owns
                    // the bottom safe-area inset.
                    .keyboardLift(
                        clearance: editingPriceRowBottom.map { max(0, tradePanelHeight - $0) },
                        maxLift: max(0, geometry.size.height - Self.chartMinHeight)
                    )
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: paneCount)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            tradeActionDock(showDisabledHint: layout == .fullscreen)
        }
        // The whole screen is sized off the reader above, so SwiftUI's automatic
        // keyboard avoidance does not politely "push the field up" here: it
        // takes the keyboard's height out of the safe area, the reader shrinks,
        // and the chart and the panel both collapse into what is left — the
        // header runs off the top and the panel smears into the chart. Raising
        // the keyboard has to leave this reader's height alone and come over it.
        //
        // Unconditionally, with no exception for the panel's custom-price field.
        // That field does sit under the keys, but putting avoidance back for it
        // bought visibility with the very collapse this opts out of — the lever
        // is the reader's height in both directions. The panel clears the keys
        // by moving itself instead; see `keyboardLift` above.
        .ignoresSafeArea(.keyboard, edges: .bottom)
        // Tap or swipe-down to put the custom-price keyboard away comes from
        // `RootView.dismissKeyboardOnInteraction()` — this screen lives in the
        // root window, so it needs no copy of its own.
    }

    private func tradeActionDock(showDisabledHint: Bool) -> some View {
        FloatingTradeButtons(isEnabled: canTrade, showDisabledHint: showDisabledHint) { side in
            tradeViewModel.arm(
                side: side,
                underlying: chartViewModel.symbol,
                chainViewModel: chainViewModel,
                bypass: settingsStore.bypassOrderConfirmation
            )
        }
    }

    private var chartView: some View {
        ChartView(
            viewModel: chartViewModel,
            onSelectSymbol: { chartViewModel.selectSymbol($0) },
            indicatorPopup: { dismiss in
                AnyView(
                    IndicatorSettingsView(
                        chart: chartViewModel,
                        chartTrading: chartTrading,
                        onOpenTwcSettings: {
                            dismiss()
                            showTwcSettings = true
                        },
                        onDismiss: dismiss
                    )
                )
            },
            onShowProfile: { showProfile = true },
            onShowHistory: { showHistory = true },
            tradingMode: tradingMode,
            onToggleMode: { showModeConfirmation = true },
            chartOrders: chartOrdersModel,
            chartTradingSettings: chartTrading.settings,
            entryLines: chartTrading.entryLines(
                positions: tradeViewModel.positions,
                symbol: chartViewModel.symbol
            ),
            canPlaceChartOrder: TradeReadiness.canPlaceChartOrder(
                contract: chainViewModel.selectedContract,
                locked: tradingLocked || needsProviderConfig
            ),
            placement: chartTrading.placementRequest.map { request in
                PlacementCardBinding(
                    request: request,
                    defaultQuantity: chartTrading.settings.defaultQuantity,
                    defaultOrderType: tradeViewModel.orderType.chartOrderType,
                    onPriceChange: { chartTrading.updatePlacementPrice($0) },
                    onPlace: { side, quantity, orderType in
                        await chartTrading.placeFromSheet(
                            side: side,
                            quantity: quantity,
                            orderType: orderType
                        )
                    },
                    onCancel: { chartTrading.dismissPlacement() }
                )
            },
            orderLineDelegate: chartTrading,
            onTripleTap: toggleLayout
        )
    }

    /// PATCH the mode, then re-init every data flow against the new
    /// environment (the desktop clone reloads the page; here we re-run the
    /// startup routines).
    private func switchTradingMode() async {
        guard let current = tradingMode else { return }
        let next: TradingMode = current == .live ? .practice : .live
        do {
            let me = try await container.apiClient.updateTradingMode(next)
            tradingMode = me.tradingMode ?? next
            self.me = me
            // Practice and live chart orders are separate sets; clearing first
            // means the chart never shows a line that cannot fire in this mode.
            chartOrdersModel.reset()
            await chartViewModel.start()
            await tradeViewModel.refreshTradingData()
            await chainViewModel.load(underlying: chartViewModel.symbol)
            await chartOrdersModel.load()
            container.quoteSocket.reconnect()
        } catch {
            tradeViewModel.showToast("Mode switch failed. Try again.", style: .error)
        }
    }

    private func refreshTradingContext() async {
        if let me = try? await container.apiClient.me() {
            tradingMode = me.tradingMode ?? tradingMode
            self.me = me
            await tradeViewModel.refreshTradingData()
            container.quoteSocket.reconnect()
        }
    }

    private var positionsStrip: PositionsStripView {
        PositionsStripView(
            positions: tradeViewModel.positions,
            openOrders: tradeViewModel.openOrders,
            workingSymbols: tradeViewModel.workingSymbols,
            tradingLocked: tradingLocked,
            onFlatten: { position in
                Task { await tradeViewModel.flatten(position) }
            },
            onCancelOrder: { order in
                Task { await tradeViewModel.cancel(order) }
            }
        )
    }

    // MARK: - Helpers

    /// Contract symbols whose live quotes the screen needs: the selected
    /// option contract and every open position. The chart's own symbol is
    /// excluded — its subscription is owned by ChartViewModel.
    private var watchedContractSymbols: [String] {
        var symbols = Set<String>()
        if let symbol = chainViewModel.selectedContract?.symbol { symbols.insert(symbol) }
        for position in tradeViewModel.positions { symbols.insert(position.symbol) }
        symbols.remove(chartViewModel.symbol)
        return symbols.sorted()
    }

    private var optionsWarning: String? {
        guard let message = chartViewModel.optionsAnalyticsErrorMessage,
              chartViewModel.optionsAnalyticsSettings.enabled
        else { return nil }
        switch chartViewModel.optionsAnalyticsDisplayState {
        case .retained:
            return "Options Structure retained snapshot: \(message)"
        case .expired:
            return "Options Structure expired: \(message)"
        default:
            return "Options Structure unavailable: \(message)"
        }
    }

    private var retryOptionsWarning: () -> Void {
        { Task { await chainViewModel.load(underlying: chartViewModel.symbol) } }
    }

    /// Same gate as the split-layout TradePanelView's Buy/Sell buttons —
    /// literally, via `TradeReadiness` — so the fullscreen floating buttons
    /// can never accept a contract the panel would refuse (an unquoted CURR
    /// placeholder, a custom price still untyped). The lock disables every
    /// order-placing control while leaving the chart untouched.
    private var canTrade: Bool {
        TradeReadiness.canTrade(
            contract: chainViewModel.selectedContract,
            locked: tradingLocked || needsProviderConfig,
            canArm: tradeViewModel.canArm
        )
    }

    // MARK: - Provider-aware copy + empty state

    private var tradingProvider: BrokerProvider { me?.tradingProvider ?? .webull }
    private var providerName: String {
        switch tradingProvider {
        case .alpaca: return "Alpaca"
        case .snaptrade: return "SnapTrade"
        case .webull: return "Webull"
        case .tradier: return "Tradier"
        }
    }
    private var activeProviderConfigured: Bool {
        guard let me else { return true }
        switch tradingProvider {
        case .alpaca:
            return tradingMode == .practice
                ? (me.alpacaPracticeConfigured ?? false)
                : (me.alpacaConfigured ?? false)
        case .snaptrade:
            return tradingMode == .practice
                ? me.snaptradePracticeAccountId != nil
                : me.snaptradeAccountId != nil
        case .webull:
            return tradingMode == .practice
                ? (me.webullPracticeConfigured ?? false)
                : (me.webullConfigured)
        case .tradier:
            // Not a selectable trading provider (see BrokerProvider doc comment);
            // treat as configured so this branch never blocks trading.
            return true
        }
    }
    private var needsProviderConfig: Bool { me != nil && !activeProviderConfigured }
    private var providerConfigMessage: String {
        tradingProvider == .snaptrade
            ? "No SnapTrade trading account selected."
            : "No \(providerName) credentials configured."
    }

    /// Shown at the top of the screen when the active provider is not ready
    /// for the current trading mode — a clear path to configure it instead of
    /// being stuck on the raw broker error at launch.
    private var providerConfigBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Color.orange)
            Text(providerConfigMessage)
                .font(.footnote)
                .foregroundStyle(Color.secondary)
            Button("Configure") { showProfile = true }
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Color.appAccent)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.hudStrokeDim, in: RoundedRectangle(cornerRadius: 8))
    }

    private func toggleLayout() {
        Haptics.selection()
        withAnimation(AppMotion.standard) {
            layout = layout == .fullscreen ? .split : .fullscreen
        }
        settingsStore.layoutMode = layout
    }

    private func toggleLock() {
        Haptics.selection()
        tradingLocked.toggle()
        settingsStore.tradingLocked = tradingLocked
    }
}

/// Keeps the screen's popup slot in step with the armed ticket.
///
/// The confirmation is an anchored popup like the chart's pickers, but nothing
/// taps it open: it belongs to `armedTicket`, so it is pushed into the slot on
/// the ticket's identity and taken back out when the ticket goes away. That
/// makes Cancel, the scrim and a successful submit all the same path — clear
/// the ticket — and leaves no way to end up with an armed order and no surface
/// showing it, or a popup with no order behind it.
///
/// A modifier rather than three more lines on `TradeScreenView.body`, which is
/// long enough that the type checker gives up on it.
private struct OrderConfirmPresentation: ViewModifier {
    @ObservedObject var tradeViewModel: TradeViewModel
    let hudMenus: HudMenuController

    /// The SELL/BUY row's box in window coordinates, reported by whichever
    /// layout is on screen.
    @State private var anchor: CGRect = .zero

    func body(content: Content) -> some View {
        content
            .onPreferenceChange(TradeActionsAnchorKey.self) { rect in
                if let rect { anchor = rect }
            }
            .onChange(of: tradeViewModel.armedTicket?.id) { _, _ in sync() }
    }

    /// `.trailing` is nominal — the panel is full width, so the edge it aligns
    /// to never shows. What matters is the anchor: the SELL/BUY row, which has
    /// the rest of the screen above it, so `HudMenuLayer` opens the popup
    /// upward and gives it the whole chart's worth of height.
    private func sync() {
        guard let ticket = tradeViewModel.armedTicket else {
            if hudMenus.presentation?.id == OrderConfirmPopup.popupID { hudMenus.dismiss() }
            return
        }
        hudMenus.present(
            id: OrderConfirmPopup.popupID,
            anchor: anchor,
            edge: .trailing,
            onUserDismiss: { OrderConfirmPopup.handleUserDismiss(tradeViewModel) },
            content: { _ in
                AnyView(OrderConfirmPopup(tradeViewModel: tradeViewModel, ticket: ticket))
            }
        )
    }
}

private struct OptionsAnalyticsLifecycleModifier: ViewModifier {
    let viewModel: ChartViewModel
    let scenePhase: ScenePhase

    func body(content: Content) -> some View {
        content
            .onAppear {
                viewModel.setOptionsAnalyticsVisible(true)
                viewModel.setOptionsAnalyticsAppActive(scenePhase == .active)
            }
            .onDisappear {
                viewModel.setOptionsAnalyticsVisible(false)
            }
            .onChange(of: scenePhase) { _, phase in
                viewModel.setOptionsAnalyticsAppActive(phase == .active)
            }
    }
}
