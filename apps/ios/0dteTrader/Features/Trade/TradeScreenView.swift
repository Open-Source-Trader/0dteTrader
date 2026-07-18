import SwiftUI

/// The main screen (PRD §3.3):
/// - Layout A (fullscreen): chart fills the screen, floating Buy/Sell overlaid.
/// - Layout B (split): chart on top, trade panel below; drag divider resizes
///   the panel between 1/4 and 1/2 of screen height.
/// Layout choice and split fraction persist (FR-12).
struct TradeScreenView: View {
    let container: AppContainer
    let onLogout: () async -> Void

    @StateObject private var chartViewModel: ChartViewModel
    @StateObject private var chainViewModel: OptionsChainViewModel
    @StateObject private var tradeViewModel: TradeViewModel

    @State private var layout: TradeLayout
    @State private var splitFraction: Double
    @State private var dragStartFraction: Double?
    @State private var showSymbolSearch = false
    @State private var showIndicatorSettings = false
    @State private var showProfile = false

    private let settingsStore: SettingsStore

    init(container: AppContainer, onLogout: @escaping () async -> Void) {
        self.container = container
        self.onLogout = onLogout
        _chartViewModel = StateObject(wrappedValue: container.makeChartViewModel())
        _chainViewModel = StateObject(wrappedValue: container.makeOptionsChainViewModel())
        _tradeViewModel = StateObject(wrappedValue: container.makeTradeViewModel())
        _layout = State(initialValue: container.settingsStore.layoutMode)
        _splitFraction = State(initialValue: container.settingsStore.splitFraction)
        self.settingsStore = container.settingsStore
    }

    var body: some View {
        NavigationStack {
            layoutContent
                .background(Color.appBackground)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            showProfile = true
                        } label: {
                            Image(systemName: "person.circle")
                        }
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
        .overlay(alignment: .top) {
            if let toast = tradeViewModel.toast {
                ToastView(toast: toast)
                    .padding(.top, 4)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .zIndex(1)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: tradeViewModel.toast)
        .sheet(item: $tradeViewModel.armedTicket) { ticket in
            OrderConfirmSheet(tradeViewModel: tradeViewModel, ticket: ticket)
        }
        .sheet(isPresented: $showSymbolSearch) {
            SymbolSearchView(currentSymbol: chartViewModel.symbol) { symbol in
                chartViewModel.selectSymbol(symbol)
            }
        }
        .sheet(isPresented: $showIndicatorSettings) {
            IndicatorSettingsView(settings: $chartViewModel.indicatorSettings)
        }
        .sheet(isPresented: $showProfile) {
            ProfileView(viewModel: container.makeProfileViewModel(onLogout: onLogout))
        }
        .task {
            await chartViewModel.start()
        }
        .task {
            await tradeViewModel.refreshTradingData()
        }
        .onAppear {
            tradeViewModel.optionContractResolver = { symbol in
                chainViewModel.chain?.contracts.first { $0.symbol == symbol }
            }
            Task { await chainViewModel.load(underlying: chartViewModel.symbol) }
            syncFuturesRoot(with: chartViewModel.symbol)
        }
        .onChange(of: chartViewModel.symbol) { _, newSymbol in
            Task { await chainViewModel.load(underlying: newSymbol) }
            syncFuturesRoot(with: newSymbol)
        }
        .onChange(of: container.quoteSocket.lastOrderUpdate) { _, update in
            if let update {
                tradeViewModel.handleOrderUpdate(update)
            }
        }
        .onChange(of: chartViewModel.alertNotice) { _, notice in
            if let notice {
                tradeViewModel.showToast(notice.message, style: .info)
            }
        }
    }

    // MARK: - Layouts

    @ViewBuilder
    private var layoutContent: some View {
        switch layout {
        case .fullscreen:
            // Layout A — FR-10.
            ZStack(alignment: .bottom) {
                chartView
                VStack(spacing: 10) {
                    positionsStrip
                    FloatingTradeButtons(isEnabled: true) { side in
                        tradeViewModel.arm(side: side, underlying: chartViewModel.symbol, chainViewModel: chainViewModel)
                    }
                }
                .padding(.bottom, 12)
            }

        case .split:
            // Layout B — FR-11 with draggable divider.
            GeometryReader { geometry in
                let totalHeight = geometry.size.height
                let panelHeight = max((totalHeight * splitFraction).rounded(), 120)
                VStack(spacing: 0) {
                    chartView
                        .frame(height: max(totalHeight - panelHeight - dividerHeight, 100))
                    divider(totalHeight: totalHeight)
                    TradePanelView(
                        tradeViewModel: tradeViewModel,
                        chainViewModel: chainViewModel,
                        underlying: chartViewModel.symbol,
                        positionsStrip: positionsStrip,
                        onArm: { side in
                            tradeViewModel.arm(side: side, underlying: chartViewModel.symbol, chainViewModel: chainViewModel)
                        }
                    )
                    .frame(height: panelHeight)
                }
                .frame(height: totalHeight)
            }
        }
    }

    private var chartView: some View {
        ChartView(
            viewModel: chartViewModel,
            onSymbolSearch: { showSymbolSearch = true },
            onIndicatorSettings: { showIndicatorSettings = true }
        )
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

    // MARK: - Divider (Layout B)

    private let dividerHeight: CGFloat = 18

    private func divider(totalHeight: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: 2.5)
            .fill(Color.appBorder)
            .frame(width: 48, height: 5)
            .frame(maxWidth: .infinity)
            .frame(height: dividerHeight)
            .background(Color.appSurface)
            .contentShape(Rectangle())
            .gesture(
                DragGesture()
                    .onChanged { value in
                        if dragStartFraction == nil {
                            dragStartFraction = splitFraction
                        }
                        let start = dragStartFraction ?? splitFraction
                        let delta = -value.translation.height / totalHeight
                        // Clamp to the PRD range: panel is 1/4...1/2 of screen height.
                        splitFraction = min(0.5, max(0.25, start + delta))
                    }
                    .onEnded { _ in
                        dragStartFraction = nil
                        settingsStore.splitFraction = splitFraction
                    }
            )
            .accessibilityLabel("Resize trade panel")
    }

    // MARK: - Helpers

    private func toggleLayout() {
        Haptics.selection()
        layout = layout == .fullscreen ? .split : .fullscreen
        settingsStore.layoutMode = layout
    }

    private func syncFuturesRoot(with symbol: String) {
        if let root = FuturesRoots.root(for: symbol) {
            Task { await tradeViewModel.setFuturesRoot(root) }
        }
    }
}
