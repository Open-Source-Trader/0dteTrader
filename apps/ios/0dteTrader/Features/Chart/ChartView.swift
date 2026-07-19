import SwiftUI
import UIKit

/// Chart surface: header (symbol, last price, interval, indicator settings),
/// candle chart with overlays, and optional RSI / MACD sub-panes.
struct ChartView: View {
    @ObservedObject var viewModel: ChartViewModel
    @ObservedObject var drawings: ChartDrawingsModel
    let onSymbolSearch: () -> Void
    let onIndicatorSettings: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showClearConfirm = false

    private let paneHeight: CGFloat = 72

    init(
        viewModel: ChartViewModel,
        onSymbolSearch: @escaping () -> Void,
        onIndicatorSettings: @escaping () -> Void
    ) {
        _viewModel = ObservedObject(wrappedValue: viewModel)
        _drawings = ObservedObject(wrappedValue: viewModel.drawings)
        self.onSymbolSearch = onSymbolSearch
        self.onIndicatorSettings = onIndicatorSettings
    }

    var body: some View {
        VStack(spacing: 0) {
            header

            if let errorMessage = viewModel.errorMessage, !viewModel.candles.isEmpty {
                staleDataBanner(errorMessage)
            }

            ZStack {
                CandleChartRepresentable(
                    candles: viewModel.candles,
                    overlays: viewModel.priceOverlays,
                    overlayColors: ChartStyle.overlayColors,
                    showVolume: viewModel.indicatorSettings.volumeEnabled,
                    intervalSeconds: viewModel.interval.seconds,
                    drawingsModel: drawings,
                    twcModel: viewModel.twcRenderModel,
                    onVisibleRangeChange: { viewModel.visibleXRange = $0 }
                )
                if let banner = viewModel.twcRenderModel?.banner {
                    TwcBiasBannerView(banner: banner)
                }
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
            }
            .layoutPriority(1)

            if let rsi = viewModel.rsiSeries {
                IndicatorPaneRepresentable(
                    series: [.init(id: rsi.id, kind: .line, values: rsi.values)],
                    colors: ["rsi": .systemYellow],
                    guideLines: [30, 70],
                    yRange: 0...100,
                    xValueCount: viewModel.candles.count,
                    visibleRange: viewModel.visibleXRange
                )
                .frame(height: paneHeight)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }

            if let macd = viewModel.macdSeries {
                IndicatorPaneRepresentable(
                    series: [
                        .init(id: macd.histogram.id, kind: .histogram, values: macd.histogram.values),
                        .init(id: macd.macd.id, kind: .line, values: macd.macd.values),
                        .init(id: macd.signal.id, kind: .line, values: macd.signal.values),
                    ],
                    colors: [
                        "macd": .systemBlue,
                        "macdSignal": .systemOrange,
                    ],
                    xValueCount: viewModel.candles.count,
                    visibleRange: viewModel.visibleXRange
                )
                .frame(height: paneHeight)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }

            if let stoch = viewModel.stochSeries {
                IndicatorPaneRepresentable(
                    series: [
                        .init(id: stoch.k.id, kind: .line, values: stoch.k.values),
                        .init(id: stoch.d.id, kind: .line, values: stoch.d.values),
                    ],
                    colors: [
                        "stochK": .systemBlue,
                        "stochD": .systemOrange,
                    ],
                    guideLines: [20, 80],
                    yRange: 0...100,
                    xValueCount: viewModel.candles.count,
                    visibleRange: viewModel.visibleXRange
                )
                .frame(height: paneHeight)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }

            if let atr = viewModel.atrSeries {
                IndicatorPaneRepresentable(
                    series: [.init(id: atr.id, kind: .line, values: atr.values)],
                    colors: ["atr": .systemTeal],
                    xValueCount: viewModel.candles.count,
                    visibleRange: viewModel.visibleXRange
                )
                .frame(height: paneHeight)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .background(Color.appBackground)
        .animation(reduceMotion ? nil : AppMotion.standard, value: viewModel.indicatorSettings)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: viewModel.errorMessage)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: viewModel.isLoading)
        .animation(reduceMotion ? nil : AppMotion.standard, value: drawings.tool)
        .animation(reduceMotion ? nil : AppMotion.standard, value: drawings.selectedId)
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

    // MARK: - Header

    private var header: some View {
        HStack(spacing: AppSpacing.lg) {
            Button {
                Haptics.selection()
                onSymbolSearch()
            } label: {
                HStack(spacing: AppSpacing.xs) {
                    Text(viewModel.symbol)
                        .font(.headline)
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.bold))
                }
                .foregroundStyle(.primary)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .accessibilityLabel("Change symbol")

            if let quote = viewModel.quote {
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: AppSpacing.xs) {
                        Text(Format.price(quote.last))
                            .font(.priceMedium)
                        if let dayChange = viewModel.dayChange {
                            Text("\(Format.signedPrice(dayChange.change)) (\(String(format: "%+.2f", dayChange.percent))%)")
                                .font(.priceSmall.weight(.medium))
                                .foregroundStyle(dayChange.change >= 0 ? Color.pnlPositive : Color.pnlNegative)
                                .accessibilityLabel(dayChange.change >= 0
                                    ? "Up \(Format.price(dayChange.change)) today"
                                    : "Down \(Format.price(abs(dayChange.change))) today")
                        }
                    }
                    Text("Bid \(Format.price(quote.bid))  Ask \(Format.price(quote.ask))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            drawingToolsMenu

            intervalMenu

            Button {
                Haptics.selection()
                onIndicatorSettings()
            } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .frame(width: 44, height: 44)
                    .background(Color.appSurfaceElevated)
                    .clipShape(Circle())
                    .contentShape(Circle())
            }
            .accessibilityLabel("Indicator settings")
        }
        .padding(.horizontal, AppSpacing.lg)
        .padding(.vertical, AppSpacing.sm)
    }

    private var intervalMenu: some View {
        Menu {
            ForEach(ChartInterval.allCases, id: \.self) { interval in
                Button(interval.rawValue) {
                    Haptics.selection()
                    viewModel.selectInterval(interval)
                }
            }
        } label: {
            Text(viewModel.interval.rawValue)
                .font(.chipLabel)
                .padding(.horizontal, AppSpacing.md)
                .frame(minHeight: 44)
                .background(Color.appSurfaceElevated)
                .clipShape(Capsule())
                .contentShape(Capsule())
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
