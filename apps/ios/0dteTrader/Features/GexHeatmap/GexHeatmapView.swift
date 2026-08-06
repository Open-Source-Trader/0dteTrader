import SwiftUI

/// GEX heatmap sheet: strike x column grid of net gamma exposure for the
/// active symbol, with a header showing symbol, price, bid, ask, and a
/// toggle between two views:
///  - Term Structure (default): strike x expiration, each expiration's own
///    latest capture — a snapshot of GEX across the chain right now.
///  - Time Series: strike x timestamp, one expiration over its capture
///    history — how GEX at this strike has moved intraday.
/// Desktop parity: apps/desktop/src/features/gexHeatmap/GexHeatmapModal.tsx.
struct GexHeatmapView: View {
    let symbol: String
    let spotPrice: Double
    let bid: Double?
    let ask: Double?
    /// Used only as the default expiration for the time-series view.
    let selectedExpiration: String?
    let apiClient: APIClient
    let settingsStore: SettingsStore

    @Environment(\.dismiss) private var dismiss
    @State private var viewMode: GexHeatmapViewMode
    @State private var columns: [GexHeatmapColumn] = []
    @State private var entries: [GexHeatmapEntry] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var loadToken = UUID()

    /// Pinch-to-zoom scale and drag pan, each committed at gesture end so the
    /// next gesture starts from where the last one left off rather than
    /// snapping back. The grid renders at its natural, fully-readable size
    /// (no shrink-to-fit, no value truncation) — zoom and pan are how you
    /// reach cells that don't fit the sheet at 1x, the same as Bullflow's
    /// GEX map. The strike column and column-header row stay pinned to the
    /// sheet's edges and pan only along their own axis, so they always label
    /// whatever data cells are currently in view.
    @State private var committedScale: CGFloat = 1
    @GestureState private var pinchScale: CGFloat = 1
    @State private var committedOffset: CGSize = .zero
    @GestureState private var dragOffset: CGSize = .zero

    private var scale: CGFloat { committedScale * pinchScale }
    private var offset: CGSize {
        CGSize(
            width: committedOffset.width + dragOffset.width,
            height: committedOffset.height + dragOffset.height
        )
    }

    private let cellWidth: CGFloat = 92
    private let strikeColumnWidth: CGFloat = 68
    private let gridRowHeight: CGFloat = 38

    init(
        symbol: String,
        spotPrice: Double,
        bid: Double?,
        ask: Double?,
        selectedExpiration: String?,
        apiClient: APIClient,
        settingsStore: SettingsStore
    ) {
        self.symbol = symbol
        self.spotPrice = spotPrice
        self.bid = bid
        self.ask = ask
        self.selectedExpiration = selectedExpiration
        self.apiClient = apiClient
        self.settingsStore = settingsStore
        _viewMode = State(initialValue: settingsStore.gexHeatmapView)
    }

    private var sortedEntries: [GexHeatmapEntry] {
        GexHeatmapMath.sortedByStrikeDescending(entries)
    }

    private var maxAbsoluteValue: Double {
        GexHeatmapMath.maxAbsoluteValue(sortedEntries)
    }

    private var closestStrike: Double? {
        GexHeatmapMath.closestStrike(sortedEntries, spotPrice: spotPrice)
    }

    private var bodyWidth: CGFloat { CGFloat(columns.count) * cellWidth }
    private var bodyHeight: CGFloat { CGFloat(sortedEntries.count) * gridRowHeight }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                header
                Divider().overlay(Color.hudStroke.opacity(0.3))
                if let errorMessage {
                    unavailableState(message: "GEX data unavailable: \(errorMessage)")
                } else if sortedEntries.isEmpty {
                    unavailableState(message: isLoading ? "Loading GEX data…" : "GEX data unavailable")
                } else {
                    grid
                }
            }
            .background(Color.black)
            .navigationTitle("GEX Heatmap")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task(id: "\(viewMode.rawValue)-\(loadToken.uuidString)") {
            await load()
        }
    }

    private func load() async {
        errorMessage = nil
        isLoading = true
        committedScale = 1
        committedOffset = .zero
        defer { isLoading = false }
        do {
            switch viewMode {
            case .termStructure:
                let snapshot = try await apiClient.gexTermStructure(
                    symbol: symbol,
                    expiration: selectedExpiration
                )
                (columns, entries) = GexHeatmapAdapters.columnsAndEntries(fromTermStructure: snapshot)
            case .timeSeries:
                let snapshot = try await apiClient.gexHeatmap(
                    symbol: symbol,
                    expiration: selectedExpiration
                )
                (columns, entries) = GexHeatmapAdapters.columnsAndEntries(fromHeatmap: snapshot)
            }
        } catch {
            errorMessage = (error as? APIError)?.userMessage ?? error.localizedDescription
        }
    }

    private func selectViewMode(_ mode: GexHeatmapViewMode) {
        guard mode != viewMode else { return }
        settingsStore.gexHeatmapView = mode
        viewMode = mode
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: AppSpacing.xs) {
            HStack(alignment: .firstTextBaseline, spacing: AppSpacing.md) {
                Text(symbol)
                    .font(.system(.body, design: .monospaced).weight(.bold))
                    .foregroundStyle(.white)
                statField(label: "Price", value: Format.price(spotPrice))
                statField(label: "Bid", value: bid.map { Format.price($0) } ?? "—")
                statField(label: "Ask", value: ask.map { Format.price($0) } ?? "—")
                Spacer()
            }
            Picker("View", selection: Binding(get: { viewMode }, set: selectViewMode)) {
                Text("Term Structure").tag(GexHeatmapViewMode.termStructure)
                Text("Time Series").tag(GexHeatmapViewMode.timeSeries)
            }
            .pickerStyle(.segmented)
        }
        .padding(.horizontal, AppSpacing.md)
        .padding(.vertical, AppSpacing.sm)
        .background(Color(white: 0.04))
    }

    private func statField(label: String, value: String) -> some View {
        HStack(spacing: 6) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.5))
            Text(value)
                .font(.system(.subheadline, design: .monospaced).weight(.semibold))
                .foregroundStyle(.white.opacity(0.85))
        }
    }

    private func unavailableState(message: String) -> some View {
        ContentUnavailableView(
            message,
            systemImage: "square.grid.3x3.fill"
        )
        .foregroundStyle(.white.opacity(0.7))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Three layers sharing one scale/offset: the scrollable data body, a
    /// column of strikes pinned to the left edge (pans vertically only), and
    /// a row of column headers pinned to the top edge (pans horizontally
    /// only), with a fixed corner cell where the two headers meet.
    private var grid: some View {
        GeometryReader { proxy in
            let clamped = clampedOffset(proposed: offset, viewport: proxy.size)

            ZStack(alignment: .topLeading) {
                dataBody
                    .padding(.leading, strikeColumnWidth)
                    .padding(.top, gridRowHeight)
                    .offset(clamped)
                    .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
                    .contentShape(Rectangle())
                    .clipped()

                columnHeaderRow
                    .offset(x: clamped.width)
                    .padding(.leading, strikeColumnWidth)
                    .frame(width: proxy.size.width, height: gridRowHeight, alignment: .topLeading)
                    .clipped()

                strikeColumn
                    .offset(y: clamped.height)
                    .padding(.top, gridRowHeight)
                    .frame(width: strikeColumnWidth, height: proxy.size.height, alignment: .topLeading)
                    .clipped()

                Text("GEX")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.6))
                    .frame(width: strikeColumnWidth, height: gridRowHeight)
                    .background(Color(white: 0.06))
            }
            .gesture(
                SimultaneousGesture(
                    MagnificationGesture()
                        .updating($pinchScale) { value, state, _ in
                            state = value
                        }
                        .onEnded { value in
                            committedScale = min(max(committedScale * value, 1), 4)
                            committedOffset = clampedOffset(proposed: committedOffset, viewport: proxy.size)
                        },
                    DragGesture()
                        .updating($dragOffset) { value, state, _ in
                            state = value.translation
                        }
                        .onEnded { value in
                            committedOffset.width += value.translation.width
                            committedOffset.height += value.translation.height
                            committedOffset = clampedOffset(proposed: committedOffset, viewport: proxy.size)
                        }
                )
            )
        }
    }

    /// Keeps at least a sliver of the body on-screen on every edge, scaled by
    /// the current zoom level. The viewport is the body's share of the sheet
    /// (total minus the pinned header row/column).
    private func clampedOffset(proposed: CGSize, viewport: CGSize) -> CGSize {
        let scaledWidth = bodyWidth * scale
        let scaledHeight = bodyHeight * scale
        let bodyViewport = CGSize(
            width: viewport.width - strikeColumnWidth,
            height: viewport.height - gridRowHeight
        )
        let minX = min(0, bodyViewport.width - scaledWidth)
        let minY = min(0, bodyViewport.height - scaledHeight)
        return CGSize(
            width: min(max(proposed.width, minX), 0),
            height: min(max(proposed.height, minY), 0)
        )
    }

    private var columnHeaderRow: some View {
        HStack(spacing: 0) {
            ForEach(columns) { column in
                Text(column.label)
                    .lineLimit(1)
                    .frame(width: cellWidth)
            }
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(.white.opacity(0.6))
        .frame(height: gridRowHeight)
        .background(Color(white: 0.06))
        .scaleEffect(x: scale, y: 1, anchor: .topLeading)
    }

    private var strikeColumn: some View {
        VStack(spacing: 0) {
            ForEach(sortedEntries, id: \.strike) { entry in
                let isSpotRow = closestStrike == entry.strike
                Text(Format.strike(entry.strike))
                    .lineLimit(1)
                    .frame(width: strikeColumnWidth, height: gridRowHeight)
                    .font(.system(.caption, design: .monospaced).weight(.semibold))
                    .foregroundStyle(isSpotRow ? .white : .white.opacity(0.85))
                    .background(isSpotRow ? Color(red: 0.23, green: 0.36, blue: 0.82) : Color(white: 0.04))
            }
        }
        .scaleEffect(x: 1, y: scale, anchor: .topLeading)
    }

    private var dataBody: some View {
        VStack(spacing: 0) {
            ForEach(sortedEntries, id: \.strike) { entry in
                dataRow(entry)
            }
        }
        .scaleEffect(scale, anchor: .topLeading)
    }

    private func dataRow(_ entry: GexHeatmapEntry) -> some View {
        let cellByColumn = Dictionary(uniqueKeysWithValues: entry.cells.map { ($0.columnKey, $0.netGex) })

        return HStack(spacing: 0) {
            ForEach(columns) { column in
                let value = cellByColumn[column.key] ?? nil
                let style = GexHeatmapMath.cellStyle(value: value, maxAbsoluteValue: maxAbsoluteValue)
                Text(GexHeatmapMath.formatGexValue(value))
                    .font(.system(.caption2, design: .monospaced).weight(.bold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .frame(width: cellWidth, height: gridRowHeight)
                    .background(style.background)
                    .overlay(Rectangle().stroke(style.borderColor, lineWidth: 1))
            }
        }
    }
}
