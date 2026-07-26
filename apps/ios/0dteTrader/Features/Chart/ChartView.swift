import SwiftUI
import UIKit

/// Chart surface: header (symbol, last price, interval, indicator settings),
/// candle chart with overlays, and optional RSI / MACD sub-panes.
struct ChartView: View {
    @ObservedObject var viewModel: ChartViewModel
    @ObservedObject var drawings: ChartDrawingsModel
    let onSymbolSearch: () -> Void
    let onIndicatorSettings: () -> Void
    /// The two account destinations, folded into this header now that the
    /// screen has no navigation bar of its own.
    var onShowProfile: () -> Void = {}
    var onShowHistory: () -> Void = {}
    /// Practice/live badge state; nil hides the badge (pre-fetch).
    let tradingMode: TradingMode?
    let onToggleMode: () -> Void
    /// Chart trading: the order-line model plus the entry lines to draw.
    /// Nil leaves the overlay off entirely.
    var chartOrders: ChartOrdersModel?
    var chartTradingSettings: ChartTradingSettings = .default
    var entryLines: [EntryLineModel] = []
    /// Whether there is a contract for a new line to trade. No contract, no
    /// placement guide: the handle would take the tap and arm nothing.
    var hasSelectedContract: Bool = false
    /// The open placement card and everything done with it; nil means no card
    /// is open — the guide may still be showing.
    var placement: PlacementCardBinding?
    weak var orderLineDelegate: OrderLineOverlayDelegate?
    /// Three taps on the candles toggle the fullscreen layout.
    var onTripleTap: () -> Void = {}

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showClearConfirm = false
    @State private var showOptionsAnalyticsDetails = false
    @State private var chartResetToken = 0
    @State private var paneResetTokens: [String: Int] = [:]

    private let paneHeight: CGFloat = 68

    init(
        viewModel: ChartViewModel,
        onSymbolSearch: @escaping () -> Void,
        onIndicatorSettings: @escaping () -> Void,
        onShowProfile: @escaping () -> Void = {},
        onShowHistory: @escaping () -> Void = {},
        tradingMode: TradingMode? = nil,
        onToggleMode: @escaping () -> Void = {},
        chartOrders: ChartOrdersModel? = nil,
        chartTradingSettings: ChartTradingSettings = .default,
        entryLines: [EntryLineModel] = [],
        hasSelectedContract: Bool = false,
        placement: PlacementCardBinding? = nil,
        orderLineDelegate: OrderLineOverlayDelegate? = nil,
        onTripleTap: @escaping () -> Void = {}
    ) {
        _viewModel = ObservedObject(wrappedValue: viewModel)
        _drawings = ObservedObject(wrappedValue: viewModel.drawings)
        self.onSymbolSearch = onSymbolSearch
        self.onIndicatorSettings = onIndicatorSettings
        self.onShowProfile = onShowProfile
        self.onShowHistory = onShowHistory
        self.tradingMode = tradingMode
        self.onToggleMode = onToggleMode
        self.chartOrders = chartOrders
        self.chartTradingSettings = chartTradingSettings
        self.entryLines = entryLines
        self.hasSelectedContract = hasSelectedContract
        self.placement = placement
        self.orderLineDelegate = orderLineDelegate
        self.onTripleTap = onTripleTap
    }

    var body: some View {
        VStack(spacing: 0) {
            header

            if let errorMessage = viewModel.errorMessage, !viewModel.candles.isEmpty {
                staleDataBanner(errorMessage)
            }

            ZStack(alignment: .topLeading) {
                CandleChartRepresentable(
                    candles: viewModel.candles,
                    overlays: viewModel.priceOverlays,
                    overlayColors: ChartStyle.overlayColors,
                    showVolume: viewModel.indicatorSettings.volumeEnabled,
                    intervalSeconds: viewModel.interval.seconds,
                    drawingsModel: drawings,
                    twcModel: viewModel.twcRenderModel,
                    optionsAnalyticsSnapshot: viewModel.optionsAnalyticsSettings.enabled
                        ? viewModel.optionsAnalyticsSnapshot
                        : nil,
                    optionsAnalyticsSettings: viewModel.optionsAnalyticsSettings,
                    chartOrdersModel: chartOrders,
                    chartTradingSettings: chartTradingSettings,
                    entryLines: entryLines,
                    hasSelectedContract: hasSelectedContract,
                    placementPrice: placement?.request.price,
                    orderLineDelegate: orderLineDelegate,
                    onTripleTap: onTripleTap,
                    resetToken: chartResetToken
                )
                resetButton { chartResetToken += 1 }
                if let banner = viewModel.twcRenderModel?.banner {
                    TwcBiasBannerView(banner: banner)
                }
                if let analyticsError = viewModel.optionsAnalyticsErrorMessage,
                   viewModel.optionsAnalyticsSettings.enabled {
                    Text(optionsAnalyticsErrorText(analyticsError))
                        .font(.caption2)
                        .foregroundStyle(Color.appWarning)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                        .padding(.leading, ChartMetrics.overlayLeading)
                        .padding(.bottom, AppSpacing.sm)
                        .allowsHitTesting(false)
                }
                chartTopBar
                if viewModel.isLoading, viewModel.candles.isEmpty {
                    loadingState
                }
                if let errorMessage = viewModel.errorMessage, viewModel.candles.isEmpty {
                    errorState(errorMessage)
                }
                if drawings.tool != .cursor {
                    toolHint
                }
                if drawings.selectedId != nil {
                    selectionBar
                }
                // Last in the ZStack, and it must stay last: the reset button,
                // the TWC banner and the STRUCT chip are all corner-anchored
                // over the same pane, and anything declared after this draws
                // over the card and takes the taps meant for it.
                if let placement {
                    // Tap-away dismiss, matching the desktop window: this must
                    // never be the thing standing between you and your chart.
                    Color.black.opacity(0.001)
                        .contentShape(Rectangle())
                        .onTapGesture(perform: placement.onCancel)
                        // VoiceOver reaches the card through the modal trait
                        // below, not by landing on the scrim.
                        .accessibilityHidden(true)
                    // Centred vertically rather than anchored to the guide: on a
                    // short pane a line-anchored card clips against the top edge.
                    // `.isModal` so VoiceOver cannot walk past it to the `+`
                    // handle and the chain — the audible version of the z-order
                    // bug this block's position fixes.
                    OrderPlacementCard(placement: placement)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
                        .padding(.trailing, AppSpacing.sm)
                        .accessibilityAddTraits(.isModal)
                }
            }
            .clipShape(HudPanelShape(chamfer: 10))
            .hudCard(accent: .hudStrokeDim, glow: false, ticks: false)
            .padding(.horizontal, AppSpacing.sm)
            .padding(.vertical, AppSpacing.xxs)
            .layoutPriority(1)

            if let rsi = viewModel.rsiSeries {
                hudPane(
                    title: "RSI (\(viewModel.indicatorSettings.rsiPeriod))",
                    readouts: [readout(for: rsi, label: "", colorId: "rsi")],
                    onReset: { paneResetTokens["rsi", default: 0] += 1 },
                    content: {
                        IndicatorPaneRepresentable(
                            series: [.init(id: rsi.id, kind: .line, values: rsi.values)],
                            colors: ["rsi": ChartStyle.paneColors["rsi"]!],
                            guideLines: [30, 70],
                            yRange: 0...100,
                            xValueCount: viewModel.candles.count,
                            resetToken: paneResetTokens["rsi", default: 0]
                        )
                    }
                )
            }

            if let macd = viewModel.macdSeries {
                hudPane(
                    title: "MACD (12, 26, 9)",
                    readouts: [
                        readout(for: macd.macd, label: "MACD", colorId: "macd"),
                        readout(for: macd.signal, label: "Sig", colorId: "macdSignal"),
                        histogramReadout(for: macd.histogram, label: "Hist"),
                    ],
                    onReset: { paneResetTokens["macd", default: 0] += 1 },
                    content: {
                        IndicatorPaneRepresentable(
                            series: [
                                .init(id: macd.histogram.id, kind: .histogram, values: macd.histogram.values),
                                .init(id: macd.macd.id, kind: .line, values: macd.macd.values),
                                .init(id: macd.signal.id, kind: .line, values: macd.signal.values),
                            ],
                            colors: [
                                "macd": ChartStyle.paneColors["macd"]!,
                                "macdSignal": ChartStyle.paneColors["macdSignal"]!,
                            ],
                            xValueCount: viewModel.candles.count,
                            resetToken: paneResetTokens["macd", default: 0]
                        )
                    }
                )
            }

            if let stoch = viewModel.stochSeries {
                let settings = viewModel.indicatorSettings
                let title = "Stoch (\(settings.stochKPeriod), \(settings.stochKSmooth), \(settings.stochDPeriod))"
                hudPane(
                    title: title,
                    readouts: [
                        readout(for: stoch.k, label: "%K", colorId: "stochK"),
                        readout(for: stoch.d, label: "%D", colorId: "stochD"),
                    ],
                    onReset: { paneResetTokens["stoch", default: 0] += 1 },
                    content: {
                        IndicatorPaneRepresentable(
                            series: [
                                .init(id: stoch.k.id, kind: .line, values: stoch.k.values),
                                .init(id: stoch.d.id, kind: .line, values: stoch.d.values),
                            ],
                            colors: [
                                "stochK": ChartStyle.paneColors["stochK"]!,
                                "stochD": ChartStyle.paneColors["stochD"]!,
                            ],
                            guideLines: [20, 80],
                            yRange: 0...100,
                            xValueCount: viewModel.candles.count,
                            resetToken: paneResetTokens["stoch", default: 0]
                        )
                    }
                )
            }

            if let atr = viewModel.atrSeries {
                hudPane(
                    title: "ATR (\(viewModel.indicatorSettings.atrPeriod))",
                    readouts: [readout(for: atr, label: "", colorId: "atr")],
                    onReset: { paneResetTokens["atr", default: 0] += 1 },
                    content: {
                        IndicatorPaneRepresentable(
                            series: [.init(id: atr.id, kind: .line, values: atr.values)],
                            colors: ["atr": ChartStyle.paneColors["atr"]!],
                            xValueCount: viewModel.candles.count,
                            resetToken: paneResetTokens["atr", default: 0]
                        )
                    }
                )
            }
        }
        .background(Color.appBackground)
        .animation(reduceMotion ? nil : AppMotion.standard, value: viewModel.indicatorSettings)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: viewModel.errorMessage)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: viewModel.isLoading)
        .animation(reduceMotion ? nil : AppMotion.standard, value: drawings.tool)
        .animation(reduceMotion ? nil : AppMotion.standard, value: drawings.selectedId)
        .sheet(isPresented: $showOptionsAnalyticsDetails) {
            if let snapshot = viewModel.optionsAnalyticsSnapshot {
                OptionsAnalyticsDetailsView(
                    snapshot: snapshot,
                    settings: viewModel.optionsAnalyticsSettings
                )
            }
        }
    }

    private func optionsAnalyticsErrorText(_ error: String) -> String {
        switch viewModel.optionsAnalyticsDisplayState {
        case .retained:
            return "Options Structure retained snapshot: \(error)"
        case .expired:
            return "Options Structure expired: \(error)"
        default:
            return "Options Structure unavailable: \(error)"
        }
    }

    // MARK: - Sub-pane HUD cards

    private struct PaneReadout: Identifiable {
        let id = UUID()
        let label: String
        let value: String
        let color: Color
    }

    private func lastValue(_ values: [Double?]) -> Double? {
        for value in values.reversed() {
            if let value { return value }
        }
        return nil
    }

    private func readout(for series: IndicatorSeries, label: String, colorId: String) -> PaneReadout {
        PaneReadout(
            label: label,
            value: lastValue(series.values).map { String(format: "%.2f", $0) } ?? "—",
            color: ChartStyle.paneColor(for: colorId)
        )
    }

    /// Histogram readout: sign color (green/red) instead of a line color.
    private func histogramReadout(for series: IndicatorSeries, label: String) -> PaneReadout {
        let value = lastValue(series.values)
        return PaneReadout(
            label: label,
            value: value.map { String(format: "%.2f", $0) } ?? "—",
            color: (value ?? 0) >= 0 ? .pnlPositive : .pnlNegative
        )
    }

    /// Chamfered card around a sub-pane with name + live readouts in the
    /// header (mockup: `RSI (14) 46.21`). `glow: false` — panes re-render on
    /// every candle tick.
    private func hudPane(
        title: String,
        readouts: [PaneReadout],
        onReset: (() -> Void)? = nil,
        @ViewBuilder content: () -> some View
    ) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: AppSpacing.md) {
                Text(title)
                    .foregroundStyle(Color.appAccent)
                    .fontWeight(.semibold)
                ForEach(readouts) { readout in
                    Text(readout.label.isEmpty ? readout.value : "\(readout.label) \(readout.value)")
                        .foregroundStyle(readout.color)
                }
                Spacer(minLength: 0)
            }
            .font(.priceSmall)
            .padding(.horizontal, AppSpacing.sm)
            .padding(.top, AppSpacing.xxs)
            ZStack(alignment: .bottomTrailing) {
                content()
                    .frame(height: paneHeight)
                if let onReset {
                    Button {
                        Haptics.impact(.light)
                        onReset()
                    } label: {
                        Text("A")
                            .font(.system(size: 9, weight: .semibold, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .frame(width: 20, height: 20)
                            .background(Color.appSurface, in: RoundedRectangle(cornerRadius: 3))
                            .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Color.hudStroke.opacity(0.5), lineWidth: 1))
                    }
                    .opacity(0.7)
                    .accessibilityLabel("Reset pane view")
                    .padding(.trailing, AppSpacing.sm)
                    .padding(.bottom, AppSpacing.xs)
                }
            }
        }
        .hudCard(accent: .hudStrokeDim, glow: false, ticks: false)
        .padding(.horizontal, AppSpacing.sm)
        .padding(.vertical, AppSpacing.xxs)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }

    // MARK: - State overlays

    private var loadingState: some View {
        VStack(spacing: AppSpacing.md) {
            ProgressView()
                .controlSize(.large)
                .tint(.secondary)
            Text("Loading \(viewModel.symbol)…")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .transition(.opacity)
    }

    private func errorState(_ message: String) -> some View {
        ErrorStateView(
            message: message,
            systemImage: "chart.xyaxis.line",
            retryTitle: "Try Again"
        ) {
            Task { await viewModel.loadCandles() }
        }
        .transition(.opacity)
    }

    /// Non-blocking notice shown above the chart when a refresh failed but
    /// cached candles are still on screen.
    private func staleDataBanner(_ message: String) -> some View {
        HStack(spacing: AppSpacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption)
            Text(message)
                .font(.caption)
                .lineLimit(1)
            Spacer()
            Button("Retry") { Task { await viewModel.loadCandles() } }
                .font(.caption.weight(.semibold))
        }
        .foregroundStyle(Color.pnlNegative)
        .padding(.horizontal, AppSpacing.lg)
        .padding(.vertical, AppSpacing.xs)
        .background(Color.pnlNegative.opacity(0.12))
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    // MARK: - Drawing overlays

    /// Dismissible guidance shown while a draw tool is armed.
    private var toolHint: some View {
        Text(drawings.tool == .trend || drawings.tool == .ray || drawings.tool == .rect
             ? "Drag on the chart to draw"
             : "Tap the chart to place")
            .font(.chipLabel)
            .foregroundStyle(.white)
            .padding(.horizontal, AppSpacing.md)
            .padding(.vertical, AppSpacing.xs)
            .background(Color.appAccentFill, in: Capsule())
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .padding(.top, AppSpacing.sm)
            .allowsHitTesting(false)
            .transition(.opacity)
    }

    /// Contextual actions for the selected drawing/alert.
    private var selectionBar: some View {
        HStack(spacing: AppSpacing.lg) {
            Button {
                Haptics.impact(.light)
                drawings.removeSelectedOrClear()
            } label: {
                Image(systemName: "trash")
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Delete selected drawing")
            Button {
                drawings.selectedId = nil
            } label: {
                Image(systemName: "xmark")
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Deselect drawing")
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(.primary)
        .background(Color.appSurfaceElevated, in: Capsule())
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .padding(.bottom, AppSpacing.md)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    private func resetButton(action: @escaping () -> Void) -> some View {
        Button {
            Haptics.impact(.light)
            action()
        } label: {
            Text("A")
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(width: 24, height: 24)
                .background(Color.appSurface, in: RoundedRectangle(cornerRadius: 4))
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color.hudStroke.opacity(0.5), lineWidth: 1))
        }
        .opacity(0.7)
        .accessibilityLabel("Reset chart view")
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
        .padding(.trailing, AppSpacing.sm)
        .padding(.bottom, 28)
    }

    // MARK: - On-chart top row

    /// Quote readout hard left, mode badge hard right, both on the pane's first
    /// line. Only the two chips inside take touches — the row has no shape of
    /// its own, so the candles still answer everywhere between them.
    private var chartTopBar: some View {
        HStack(alignment: .top, spacing: AppSpacing.sm) {
            VStack(alignment: .leading, spacing: AppSpacing.xs) {
                if let quote = viewModel.quote {
                    ChartQuoteReadout(
                        quote: quote,
                        dayChange: viewModel.dayChange,
                        tickProgress: viewModel.tickProgress
                    )
                }
                if let snapshot = viewModel.optionsAnalyticsSnapshot,
                   viewModel.optionsAnalyticsSettings.enabled {
                    ChartStructChip(
                        snapshot: snapshot,
                        displayState: viewModel.optionsAnalyticsDisplayState,
                        settings: viewModel.optionsAnalyticsSettings
                    ) {
                        showOptionsAnalyticsDetails = true
                    }
                }
            }
            Spacer(minLength: AppSpacing.sm)
            if let tradingMode {
                TradingModeBadge(mode: tradingMode, action: onToggleMode)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.leading, ChartMetrics.overlayLeading)
        .padding(.trailing, AppSpacing.sm)
        .padding(.top, AppSpacing.sm)
        // Capped for the same reason the header is: past XXXL the readout wraps
        // and starts covering the candles it is supposed to be labelling. The
        // numbers are still read in full by VoiceOver, and the trade panel —
        // where the sizes that matter are confirmed — scales without a ceiling.
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    // MARK: - Header

    /// One bar for the whole top of the screen: wordmark and the two account
    /// destinations on the left, chart controls on the right. The quote block
    /// that used to sit between them now labels the candles instead, which is
    /// what made room for the navigation bar to be folded in here.
    private var header: some View {
        HStack(spacing: AppSpacing.xs) {
            Text("0dteTrader")
                .font(.hudButton)
                .foregroundStyle(Color.appAccent)
                .shadow(color: .hudGlow, radius: 8)
                // Same rule as the toolbar slot this replaces: scale the
                // wordmark rather than truncate it to "0dteTr…". It is also the
                // one item here with no touch target to protect, so it is the
                // one that gives ground first at large Dynamic Type sizes.
                .lineLimit(1)
                .minimumScaleFactor(0.45)
                .allowsTightening(true)
                .layoutPriority(-1)

            Button {
                onShowProfile()
            } label: {
                Image(systemName: "person.circle")
                    .font(.title3)
                    .foregroundStyle(Color.appAccent)
                    .frame(width: 34, height: 36)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Profile")

            Button {
                onShowHistory()
            } label: {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.subheadline)
                    .foregroundStyle(Color.appAccent)
                    .frame(width: 34, height: 36)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Trade history")

            Spacer(minLength: AppSpacing.xs)

            Button {
                Haptics.selection()
                onSymbolSearch()
            } label: {
                HStack(spacing: AppSpacing.xs) {
                    Text(viewModel.symbol)
                        .font(.hudButton)
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(Color.appAccent)
                }
                .foregroundStyle(.primary)
                .padding(.horizontal, AppSpacing.sm)
                .frame(minHeight: 36)
                .background {
                    HudPanelShape(chamfer: 6)
                        .fill(Color.hudPanel)
                        .overlay {
                            HudPanelShape(chamfer: 6)
                                .strokeBorder(Color.hudStroke.opacity(0.6), lineWidth: 1.2)
                        }
                }
                .contentShape(Rectangle())
            }
            .accessibilityLabel("Change symbol")

            intervalMenu

            drawingToolsMenu

            Button {
                Haptics.selection()
                onIndicatorSettings()
            } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.subheadline)
                    .foregroundStyle(Color.appAccent)
                    .frame(width: 36, height: 36)
                    .background {
                        Circle()
                            .fill(Color.hudPanel)
                            .overlay { Circle().strokeBorder(Color.hudStroke.opacity(0.35), lineWidth: 1) }
                    }
                    .contentShape(Circle())
            }
            .accessibilityLabel("Indicator settings")
        }
        .padding(.horizontal, AppSpacing.sm)
        .padding(.vertical, AppSpacing.xs)
        .hudCard(accent: .hudStrokeDim, chamfer: 8, glow: false, ticks: false)
        .padding(.horizontal, AppSpacing.sm)
        .padding(.top, AppSpacing.xxs)
        // Seven controls on one line: at the accessibility sizes the glyphs
        // outgrow their 36pt targets and start overlapping each other, which is
        // worse than not scaling. Capped at XXXL, where it still fits with room
        // to spare; every button keeps its VoiceOver label and its touch target.
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    private var intervalMenu: some View {
        Menu {
            ForEach(AnyChartInterval.allCases, id: \.self) { interval in
                Button(interval.rawValue.uppercased()) {
                    Haptics.selection()
                    viewModel.selectInterval(interval)
                }
            }
        } label: {
            Text(viewModel.interval.rawValue.uppercased())
                .font(.chipLabel)
                .foregroundStyle(Color.appAccent)
                .padding(.horizontal, AppSpacing.md)
                .frame(minHeight: 36)
                .background {
                    HudPanelShape(chamfer: 6)
                        .fill(Color.hudPanel)
                        .overlay {
                            HudPanelShape(chamfer: 6)
                                .strokeBorder(Color.hudStroke.opacity(0.35), lineWidth: 1)
                        }
                }
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Chart interval")
        .accessibilityValue(viewModel.interval.rawValue)
    }

    /// Drawing tools dropdown (TradingView-style annotations).
    private var drawingToolsMenu: some View {
        Menu {
            ForEach(DrawingTool.allCases) { tool in
                Button {
                    drawings.tool = tool
                } label: {
                    if drawings.tool == tool {
                        Label(tool.title, systemImage: "checkmark")
                    } else {
                        Label(tool.title, systemImage: tool.systemImage)
                    }
                }
            }
            if drawings.hasAnnotations {
                Button(role: .destructive) {
                    if drawings.selectedId != nil {
                        drawings.removeSelectedOrClear()
                    } else {
                        showClearConfirm = true
                    }
                } label: {
                    Label(
                        drawings.selectedId != nil ? "Delete Selection" : "Clear All Drawings",
                        systemImage: "trash"
                    )
                }
            }
        } label: {
            Image(systemName: drawings.tool == .cursor ? "pencil.and.outline" : drawings.tool.systemImage)
                .font(.subheadline)
                .foregroundStyle(drawings.tool == .cursor ? AnyShapeStyle(.primary) : AnyShapeStyle(.white))
                .frame(width: 44, height: 44)
                .background(drawings.tool == .cursor ? Color.appSurfaceElevated : Color.appAccentFill)
                .clipShape(Circle())
                .contentShape(Circle())
        }
        .accessibilityLabel("Drawing tools")
        .confirmationDialog(
            "Clear all drawings and alerts for this symbol?",
            isPresented: $showClearConfirm,
            titleVisibility: .visible
        ) {
            Button("Clear All", role: .destructive) { drawings.removeSelectedOrClear() }
            Button("Cancel", role: .cancel) {}
        }
    }
}
