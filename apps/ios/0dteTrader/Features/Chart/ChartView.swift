import SwiftUI
import UIKit

/// Metrics the title strip's controls share. The profile and history buttons
/// and the mode badge are one row of three, and one row of three is one height.
enum ChartHeader {
    static let controlWidth: CGFloat = 34
    static let controlHeight: CGFloat = 36

    /// The mode badge's drawn box — the *glyph's* circle, not the button's
    /// touch frame.
    ///
    /// `controlHeight` is the 36pt target the profile and history buttons keep;
    /// the ring you actually see inside the profile button is smaller, and it is
    /// the thing the badge's border is supposed to match. Measured off the
    /// running app at 60px on a 3x screen — exactly 20pt, which is also what
    /// `person.circle` draws at `.title3`. The badge keeps its own 44pt-class
    /// row height from the buttons beside it, so shrinking the box costs it no
    /// touch area.
    static let badgeHeight: CGFloat = 20

    /// The drawn box the two account buttons' glyphs are framed to.
    ///
    /// Deliberately `badgeHeight` and not a number of its own: the badge's
    /// border is the profile circle's diameter, and the glyph box is that same
    /// circle. Framing both glyphs to it also evens the two buttons out —
    /// `person.circle` and `clock.arrow.circlepath` have different intrinsic
    /// widths, and unframed they draw at two visibly different sizes.
    static let glyphBox: CGFloat = badgeHeight
}

/// Chart surface: header (symbol, last price, interval, indicator settings),
/// candle chart with overlays, and optional RSI / MACD sub-panes.
struct ChartView: View {
    @ObservedObject var viewModel: ChartViewModel
    @ObservedObject var drawings: ChartDrawingsModel
    /// Picks a new symbol. The picker is a dropdown under the ticker chip now,
    /// so the chip owns the popup and the screen only receives the choice.
    let onSelectSymbol: (String) -> Void
    /// Body of the indicator chip's dropdown, built by the screen because the
    /// settings it edits are not all the chart view model's. Handed the closure
    /// that puts the popup away.
    let indicatorPopup: (@escaping () -> Void) -> AnyView
    /// The two account destinations, folded into this header now that the
    /// screen has no navigation bar of its own.
    var onShowProfile: () -> Void = {}
    var onShowHistory: () -> Void = {}
    /// Opens the GEX heatmap sheet for the active symbol. Nil hides the button.
    var onShowGexHeatmap: (() -> Void)?
    /// Practice/live badge state; nil hides the badge (pre-fetch).
    let tradingMode: TradingMode?
    let onToggleMode: () -> Void
    /// Chart trading: the order-line model plus the entry lines to draw.
    /// Nil leaves the overlay off entirely.
    var chartOrders: ChartOrdersModel?
    var chartTradingSettings: ChartTradingSettings = .default
    var entryLines: [EntryLineModel] = []
    /// Whether a new line may be placed at all — `TradeReadiness`'s chart
    /// gate: a selected contract WITH a live quote, and trading unlocked. No
    /// quoted contract, no placement guide: the handle would take the tap
    /// and arm nothing (or price off a 0.00 placeholder).
    var canPlaceChartOrder: Bool = false
    /// The open placement card and everything done with it; nil means no card
    /// is open — the guide may still be showing.
    var placement: PlacementCardBinding?
    weak var orderLineDelegate: OrderLineOverlayDelegate?
    /// Three taps on the candles toggle the fullscreen layout.
    var onTripleTap: () -> Void = {}

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showOptionsAnalyticsDetails = false
    @State private var chartResetToken = 0
    @State private var paneResetTokens: [String: Int] = [:]
    /// Width of the wider chip group on the pane's first line; what the centred
    /// quote readout is held clear of on both sides.
    @State private var chipGroupWidth: CGFloat = 0

    private let paneHeight: CGFloat = 68

    init(
        viewModel: ChartViewModel,
        onSelectSymbol: @escaping (String) -> Void,
        indicatorPopup: @escaping (@escaping () -> Void) -> AnyView,
        onShowProfile: @escaping () -> Void = {},
        onShowHistory: @escaping () -> Void = {},
        onShowGexHeatmap: (() -> Void)? = nil,
        tradingMode: TradingMode? = nil,
        onToggleMode: @escaping () -> Void = {},
        chartOrders: ChartOrdersModel? = nil,
        chartTradingSettings: ChartTradingSettings = .default,
        entryLines: [EntryLineModel] = [],
        canPlaceChartOrder: Bool = false,
        placement: PlacementCardBinding? = nil,
        orderLineDelegate: OrderLineOverlayDelegate? = nil,
        onTripleTap: @escaping () -> Void = {}
    ) {
        _viewModel = ObservedObject(wrappedValue: viewModel)
        _drawings = ObservedObject(wrappedValue: viewModel.drawings)
        self.onSelectSymbol = onSelectSymbol
        self.indicatorPopup = indicatorPopup
        self.onShowProfile = onShowProfile
        self.onShowHistory = onShowHistory
        self.onShowGexHeatmap = onShowGexHeatmap
        self.tradingMode = tradingMode
        self.onToggleMode = onToggleMode
        self.chartOrders = chartOrders
        self.chartTradingSettings = chartTradingSettings
        self.entryLines = entryLines
        self.canPlaceChartOrder = canPlaceChartOrder
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
                    overlayColors: viewModel.indicatorColors,
                    indicatorFillPlans: viewModel.overlayRenderPlans,
                    indicatorProfileRows: viewModel.priceProfileRows,
                    showVolume: viewModel.chartDisplayPreferences.volumeEnabled,
                    volumeWeightedCandleWidth: viewModel.chartDisplayPreferences.volumeWeightedCandleWidth,
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
                    canPlaceChartOrder: canPlaceChartOrder,
                    placementPrice: placement?.request.price,
                    orderLineDelegate: orderLineDelegate,
                    onTripleTap: onTripleTap,
                    resetToken: chartResetToken
                )
                resetButton { chartResetToken += 1 }
                if let banner = viewModel.twcRenderModel?.banner {
                    TwcBiasBannerView(banner: banner)
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
            .clipShape(HudPanelShape(chamfer: ChartMetrics.paneChamfer))
            .hudCard(accent: .hudStrokeDim, chamfer: ChartMetrics.paneChamfer, glow: false, ticks: false)
            .padding(.horizontal, AppSpacing.sm)
            .padding(.vertical, AppSpacing.xxs)
            .layoutPriority(1)

            ForEach(viewModel.subPanePresentations) { presentation in
                indicatorPane(presentation)
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

    private func readouts(for presentation: IndicatorPanePresentation) -> [PaneReadout] {
        presentation.series.map { series in
            let value = lastValue(series.values)
            let color = series.kind == .histogram
                ? ((value ?? 0) >= 0 ? Color.pnlPositive : Color.pnlNegative)
                : ChartStyle.indicatorSwiftUIColor(for: series.styleToken)
            return PaneReadout(
                label: presentation.series.count == 1 ? "" : series.label,
                value: value.map { String(format: "%.2f", $0) } ?? "—",
                color: color
            )
        }
    }

    @ViewBuilder
    private func indicatorPane(_ presentation: IndicatorPanePresentation) -> some View {
        hudPane(
            title: presentation.title,
            readouts: readouts(for: presentation),
            onReset: { paneResetTokens[presentation.id, default: 0] += 1 },
            content: {
                if let reason = presentation.unavailableReason {
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(Color.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    IndicatorPaneRepresentable(
                        series: presentation.series.map { series in
                            .init(
                                id: series.styleToken,
                                kind: series.kind == .histogram ? .histogram : .line,
                                values: series.values
                            )
                        },
                        colors: viewModel.indicatorColors,
                        guideLines: presentation.guideLines,
                        yRange: presentation.yRange,
                        xValueCount: viewModel.candles.count,
                        resetToken: paneResetTokens[presentation.id, default: 0]
                    )
                }
            }
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
                    .foregroundStyle(Color.secondary)
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
                            .chartCornerControlChrome(size: 20, cornerRadius: 3)
                    }
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
                .foregroundStyle(Color.secondary)
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
        .foregroundStyle(Color.secondary)
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
                .chartCornerControlChrome(
                    size: ChartMetrics.cornerControlSize,
                    cornerRadius: ChartMetrics.cornerControlRadius
                )
        }
        .accessibilityLabel("Reset chart view")
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
        // Seated in the corner cut rather than parked above the time axis: the
        // same gap to the bottom border, the right border and the chamfer. The
        // trailing inset is also what the placement guide's `+` measures from,
        // which is what puts the two in one column.
        .padding(.trailing, ChartMetrics.cornerControlInset)
        .padding(.bottom, ChartMetrics.cornerControlInset)
    }

    // MARK: - On-chart top row

    /// The chart's whole control row: symbol and interval hard left, indicator
    /// settings and drawing tools hard right, quote readout centred on the
    /// pane's midline between them, all on the pane's first line.
    ///
    /// The readout is laid out over the row rather than in it. Matching Spacers
    /// centre a view in the *gap* the two groups leave, which is the pane's
    /// midline only while the groups are the same width; the mode badge's
    /// departure left them unequal, and "the middle of the top" is the midline.
    /// So the readout takes the full width and is held off both groups by the
    /// wider one's own measured width — it gives ground on a narrow pane
    /// (scaling, then truncating) instead of running under a chip.
    ///
    /// Only the chips take touches — the row has no shape of its own, so the
    /// candles still answer the single tap and the triple tap everywhere
    /// between them.
    private var chartTopBar: some View {
        ZStack(alignment: .top) {
            VStack(spacing: AppSpacing.xs) {
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
            .frame(maxWidth: .infinity)
            .padding(.horizontal, chipGroupWidth + AppSpacing.sm)

            HStack(alignment: .top, spacing: AppSpacing.xs) {
                HStack(alignment: .top, spacing: AppSpacing.xs) {
                    ChartSymbolButton(symbol: viewModel.symbol, onSelect: onSelectSymbol)
                    ChartIntervalMenu(interval: viewModel.interval) { viewModel.selectInterval($0) }
                }
                .measuringChipGroup()
                Spacer(minLength: AppSpacing.sm)
                HStack(alignment: .top, spacing: AppSpacing.xs) {
                    ChartIndicatorButton(content: indicatorPopup)
                    ChartDrawingToolsMenu(drawings: drawings)
                }
                .measuringChipGroup()
            }
        }
        .onPreferenceChange(ChipGroupWidthKey.self) { chipGroupWidth = $0 }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.horizontal, AppSpacing.sm)
        .padding(.top, AppSpacing.sm)
        // Capped for the same reason the header is: past XXXL the readout wraps
        // and starts covering the candles it is supposed to be labelling. The
        // numbers are still read in full by VoiceOver, and the trade panel —
        // where the sizes that matter are confirmed — scales without a ceiling.
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    // MARK: - Header

    /// The title row: the two account destinations on the left, the mode badge
    /// hard right, the wordmark centred. No card of its own — every chart
    /// control has moved onto the pane, and a bordered strip around these items
    /// read as a second surface stacked on the chart's rather than as a title.
    ///
    /// The badge is 8pt off the top-trailing corner here, the same inset it kept
    /// against the chart's border. It gives that border back to the placement
    /// guide, whose `+` can be summoned to any level including the ones nearest
    /// the top edge, and to the options-analytics rail's topmost readout —
    /// both of which the badge used to shadow.
    ///
    /// The wordmark is stacked rather than laid out beside the buttons: the two
    /// sides are unequal, and any row arrangement centres it between them
    /// instead of on the bar's midline.
    private var header: some View {
        ZStack {
            Text("0dteTrader")
                .font(.hudTitle)
                // The one accent left in this bar. The chrome text around it
                // went grey; the wordmark is the brand mark, not chrome, and
                // the glow is what it is drawn with rather than a colour on it.
                .foregroundStyle(Color.appAccent)
                .shadow(color: .hudGlow, radius: 8)
                // Same rule as the toolbar slot this replaces: scale the
                // wordmark rather than truncate it to "0dteTr…". It is also the
                // one item here with no touch target to protect, so it is the
                // one that gives ground first at large Dynamic Type sizes.
                .lineLimit(1)
                .minimumScaleFactor(0.45)
                .allowsTightening(true)

            HStack(spacing: AppSpacing.xs) {
                Button {
                    onShowProfile()
                } label: {
                    Image(systemName: "person.circle")
                        .font(.title3)
                        .headerGlyphChrome()
                }
                .accessibilityLabel("Profile")

                Button {
                    onShowHistory()
                } label: {
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.subheadline)
                        .headerGlyphChrome()
                }
                .accessibilityLabel("Trade history")

                if let onShowGexHeatmap {
                    Button {
                        onShowGexHeatmap()
                    } label: {
                        Image(systemName: "square.grid.3x3.fill")
                            .font(.subheadline)
                            .headerGlyphChrome()
                    }
                    .accessibilityLabel("GEX heatmap")
                }

                Spacer(minLength: AppSpacing.sm)

                if let tradingMode {
                    TradingModeBadge(mode: tradingMode, action: onToggleMode)
                }
            }
        }
        .padding(.horizontal, AppSpacing.sm)
        .padding(.top, AppSpacing.xs)
        .padding(.bottom, AppSpacing.xxs)
        // Capped for the same reason the chip row is: past XXXL the glyphs
        // outgrow their 36pt targets. Both buttons keep their VoiceOver label
        // and their touch target.
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }
}
