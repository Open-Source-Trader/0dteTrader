import SwiftUI
import UIKit

/// Chart surface: header (symbol, last price, interval, indicator settings),
/// candle chart with overlays, and optional RSI / MACD sub-panes.
struct ChartView: View {
    @ObservedObject var viewModel: ChartViewModel
    @ObservedObject var drawings: ChartDrawingsModel
    let onSymbolSearch: () -> Void
    let onIndicatorSettings: () -> Void

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

    private static let overlayColors: [String: UIColor] = [
        "sma": .systemOrange,
        "ema": .systemCyan,
        "vwap": .systemPurple,
        "bollingerUpper": .systemGray,
        "bollingerMiddle": .systemTeal,
        "bollingerLower": .systemGray,
    ]

    var body: some View {
        VStack(spacing: 0) {
            header
            ZStack {
                CandleChartRepresentable(
                    candles: viewModel.candles,
                    overlays: viewModel.priceOverlays,
                    overlayColors: Self.overlayColors,
                    showVolume: viewModel.indicatorSettings.volumeEnabled,
                    intervalSeconds: viewModel.interval.seconds,
                    drawingsModel: drawings
                )
                if viewModel.isLoading {
                    ProgressView()
                        .tint(.secondary)
                }
                if let errorMessage = viewModel.errorMessage, viewModel.candles.isEmpty {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding()
                }
            }
            .layoutPriority(1)

            if let rsi = viewModel.rsiSeries {
                IndicatorPaneRepresentable(
                    series: [.init(id: rsi.id, kind: .line, values: rsi.values)],
                    colors: ["rsi": .systemYellow],
                    guideLines: [30, 70],
                    yRange: 0...100,
                    xValueCount: viewModel.candles.count
                )
                .frame(height: 72)
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
                    xValueCount: viewModel.candles.count
                )
                .frame(height: 84)
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
                    xValueCount: viewModel.candles.count
                )
                .frame(height: 72)
            }

            if let atr = viewModel.atrSeries {
                IndicatorPaneRepresentable(
                    series: [.init(id: atr.id, kind: .line, values: atr.values)],
                    colors: ["atr": .systemTeal],
                    xValueCount: viewModel.candles.count
                )
                .frame(height: 72)
            }
        }
        .background(Color.appBackground)
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 12) {
            Button {
                Haptics.selection()
                onSymbolSearch()
            } label: {
                HStack(spacing: 4) {
                    Text(viewModel.symbol)
                        .font(.headline)
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.bold))
                }
                .foregroundStyle(.primary)
            }

            if let quote = viewModel.quote {
                VStack(alignment: .leading, spacing: 1) {
                    Text(Format.price(quote.last))
                        .font(.priceMedium)
                    Text("B \(Format.price(quote.bid))  A \(Format.price(quote.ask))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            drawingToolsMenu

            Menu {
                ForEach(ChartInterval.allCases, id: \.self) { interval in
                    Button(interval.rawValue) {
                        viewModel.selectInterval(interval)
                    }
                }
            } label: {
                Text(viewModel.interval.rawValue)
                    .font(.chipLabel)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color.appSurfaceElevated)
                    .clipShape(Capsule())
            }

            Button {
                Haptics.selection()
                onIndicatorSettings()
            } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .padding(8)
                    .background(Color.appSurfaceElevated)
                    .clipShape(Circle())
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
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
                    drawings.removeSelectedOrClear()
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
                .padding(8)
                .background(drawings.tool == .cursor ? Color.appSurfaceElevated : Color.appAccent)
                .clipShape(Circle())
        }
        .accessibilityLabel("Drawing tools")
    }
}
