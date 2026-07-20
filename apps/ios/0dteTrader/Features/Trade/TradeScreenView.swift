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

    @State private var layout: TradeLayout
    @State private var showSymbolSearch = false
    @State private var showIndicatorSettings = false
    @State private var showProfile = false
    @State private var showHistory = false
    // 'nil' until /v1/me answers; the server value wins (desktop parity).
    @State private var tradingMode: TradingMode?
    @State private var showModeConfirmation = false
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
        _layout = State(initialValue: container.settingsStore.layoutMode)
        self.settingsStore = container.settingsStore
    }

    var body: some View {
        NavigationStack {
            layoutContent
                .background(Color.appBackground)
                .overlay(alignment: .top) {
                    if let toast = tradeViewModel.toast {
                        ToastView(toast: toast, onDismiss: { tradeViewModel.dismissCurrentToast() })
                            .padding(.top, AppSpacing.sm)
                            .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
                            .zIndex(1)
                    }
                }
                .animation(AppMotion.standard, value: tradeViewModel.toast)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .principal) {
                        Text("0dteTrader")
                            .font(.hudTitle)
                            .foregroundStyle(Color.appAccent)
                            .shadow(color: .hudGlow, radius: 8)
                    }
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            showProfile = true
                        } label: {
                            Image(systemName: "person.circle")
                        }
                        .accessibilityLabel("Profile")
                    }
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            showHistory = true
                        } label: {
                            Image(systemName: "clock.arrow.circlepath")
                        }
                        .accessibilityLabel("Trade history")
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            toggleLayout()
                        } label: {
                            Image(systemName: layout == .fullscreen ? "rectangle.split.1x2" : "rectangle")
                        }
                        .accessibilityLabel("Toggle layout")
                    }
                }
        }
        .modifier(
            OptionsAnalyticsLifecycleModifier(
                viewModel: chartViewModel,
                scenePhase: scenePhase
            )
        )
        .sheet(item: $tradeViewModel.armedTicket) { ticket in
            OrderConfirmSheet(tradeViewModel: tradeViewModel, ticket: ticket)
        }
        .sheet(isPresented: $showSymbolSearch) {
            SymbolSearchView(currentSymbol: chartViewModel.symbol) { symbol in
                chartViewModel.selectSymbol(symbol)
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showIndicatorSettings) {
            IndicatorSettingsView(
                settings: $chartViewModel.indicatorSettings,
                twcSettings: $chartViewModel.twcSettings,
                optionsAnalyticsSettings: $chartViewModel.optionsAnalyticsSettings
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showProfile) {
            ProfileView(viewModel: profileViewModel)
        }
        .sheet(isPresented: $showHistory) {
            HistoryView(apiClient: container.apiClient)
        }
        .task {
            await chartViewModel.start()
        }
        .task {
            if let me = try? await container.apiClient.me() {
                tradingMode = me.tradingMode ?? .practice
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
            Text("Orders will route to the \(tradingMode == .live ? "practice" : "LIVE") Webull environment.")
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
            tradeViewModel.optionContractResolver = { symbol in
                chainViewModel.chain?.contracts.first { $0.symbol == symbol }
            }
            Task { await chainViewModel.load(underlying: chartViewModel.symbol) }
            container.quoteSocket.subscribe(symbols: watchedContractSymbols)
        }
        .onChange(of: chartViewModel.symbol) { _, newSymbol in
            Task { await chainViewModel.load(underlying: newSymbol) }
        }
        .onChange(of: chainViewModel.selectedExpiration) { _, expiration in
            chartViewModel.optionsAnalyticsExpiration = expiration
        }
        .onChange(of: container.quoteSocket.lastOrderUpdate) { _, update in
            if let update {
                tradeViewModel.handleOrderUpdate(update)
            }
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

    /// Panel fraction driven by sub-pane count (desktop parity): the panel
    /// shrinks as indicators appear so the chart keeps enough room. The panel
    /// content compacts via its density tier — it never scrolls.
    private static let panelFractions: [CGFloat] = [1.0 / 3.0, 0.30, 0.27]
    private static let panelDensities: [TradePanelDensity] = [.roomy, .compact, .dense]

    private var paneCount: Int {
        chartViewModel.indicatorSettings.enabledSubPaneCount
    }

    @ViewBuilder
    private var layoutContent: some View {
        switch layout {
        case .fullscreen:
            // Layout A — FR-10.
            ZStack(alignment: .bottom) {
                chartView
                VStack(spacing: AppSpacing.sm) {
                    positionsStrip
                    FloatingTradeButtons(isEnabled: canTrade) { side in
                        tradeViewModel.arm(side: side, underlying: chartViewModel.symbol, chainViewModel: chainViewModel)
                    }
                }
                .padding(.bottom, AppSpacing.lg)
                .background(
                    LinearGradient(colors: [.clear, Color.appBackground],
                                   startPoint: .top, endPoint: .bottom)
                        .ignoresSafeArea(edges: .bottom)
                )
            }

        case .split:
            // Layout B — automatic sizing based on indicator count (desktop parity).
            GeometryReader { geometry in
                let totalHeight = geometry.size.height
                let fraction = Self.panelFractions[min(paneCount, Self.panelFractions.count - 1)]
                let panelHeight = (totalHeight * fraction).rounded()
                let chartHeight = max(totalHeight - panelHeight - 1, 96)
                VStack(spacing: 0) {
                    chartView
                        .frame(height: chartHeight)
                    // Static hairline divider
                    Rectangle()
                        .fill(Color.hudStroke.opacity(0.35))
                        .frame(height: 1)
                    TradePanelView(
                        tradeViewModel: tradeViewModel,
                        chainViewModel: chainViewModel,
                        underlying: chartViewModel.symbol,
                        positionsStrip: positionsStrip,
                        density: Self.panelDensities[min(paneCount, Self.panelDensities.count - 1)],
                        onArm: { side in
                            tradeViewModel.arm(side: side, underlying: chartViewModel.symbol, chainViewModel: chainViewModel)
                        }
                    )
                    .frame(height: panelHeight)
                    .clipped()
                }
                .frame(height: totalHeight)
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: paneCount)
            }
        }
    }

    private var chartView: some View {
        ChartView(
            viewModel: chartViewModel,
            onSymbolSearch: { showSymbolSearch = true },
            onIndicatorSettings: { showIndicatorSettings = true },
            tradingMode: tradingMode,
            onToggleMode: { showModeConfirmation = true }
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
            await chartViewModel.start()
            await tradeViewModel.refreshTradingData()
            await chainViewModel.load(underlying: chartViewModel.symbol)
        } catch {
            tradeViewModel.showToast("Mode switch failed. Try again.", style: .error)
        }
    }

    private var positionsStrip: PositionsStripView {
        PositionsStripView(
            positions: tradeViewModel.positions,
            openOrders: tradeViewModel.openOrders,
            workingSymbols: tradeViewModel.workingSymbols,
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

    /// Same gate as the split-layout TradePanelView's Buy/Sell buttons.
    private var canTrade: Bool {
        chainViewModel.selectedContract != nil
    }

    private func toggleLayout() {
        Haptics.selection()
        withAnimation(AppMotion.standard) {
            layout = layout == .fullscreen ? .split : .fullscreen
        }
        settingsStore.layoutMode = layout
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
