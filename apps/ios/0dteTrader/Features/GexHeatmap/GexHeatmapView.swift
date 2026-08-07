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
    /// Every expiration for the current chain, for the time-series picker.
    let expirations: [String]
    /// Default expiration for the time-series view — the chain's current
    /// selection — until the user picks a different one in the sheet.
    let selectedExpiration: String?
    /// Downsamples the time-series columns to match the chart's candle size.
    let chartInterval: AnyChartInterval
    let apiClient: APIClient
    let settingsStore: SettingsStore

    @Environment(\.dismiss) private var dismiss
    @State private var viewMode: GexHeatmapViewMode
    /// Time series' own expiration choice, independent of term structure
    /// (which always spans every near expiration).
    @State private var timeSeriesExpiration: String?
    @State private var columns: [GexHeatmapColumn] = []
    /// Pre-sorted, pre-formatted, pre-colored — built once per data load by
    /// `GexHeatmapMath.buildRenderedRows`, not derived inside `body`. Reading
    /// `entries` directly from a gesture-driven view would re-sort, re-format
    /// every cell's `NumberFormatter` string, and re-run color interpolation
    /// on every touch-move frame of a drag; this is computed exactly once
    /// per load instead.
    @State private var renderedRows: [RenderedGexRow] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var loadToken = UUID()
    /// Set once per sheet-open the first time real rows load, so the initial
    /// pan centers the spot strike without fighting the user's own scrolling
    /// on every subsequent refresh.
    @State private var hasCenteredOnSpot = false
    /// The grid body's own viewport height (sheet height minus the pinned
    /// header row), captured from `GeometryReader` so centering math can run
    /// outside the view builder.
    @State private var gridViewportHeight: CGFloat = 0

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
        expirations: [String],
        selectedExpiration: String?,
        chartInterval: AnyChartInterval,
        apiClient: APIClient,
        settingsStore: SettingsStore
    ) {
        self.symbol = symbol
        self.spotPrice = spotPrice
        self.bid = bid
        self.ask = ask
        self.expirations = expirations
        self.selectedExpiration = selectedExpiration
        self.chartInterval = chartInterval
        self.apiClient = apiClient
        self.settingsStore = settingsStore
        _viewMode = State(initialValue: settingsStore.gexHeatmapView)
        _timeSeriesExpiration = State(initialValue: selectedExpiration)
    }

    private var bodyWidth: CGFloat { CGFloat(columns.count) * cellWidth }
    private var bodyHeight: CGFloat { CGFloat(renderedRows.count) * gridRowHeight }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                header
                Divider().overlay(Color.hudStroke.opacity(0.3))
                if let errorMessage {
                    unavailableState(message: "GEX data unavailable: \(errorMessage)")
                } else if renderedRows.isEmpty {
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
        .task(id: "\(viewMode.rawValue)-\(timeSeriesExpiration ?? "")-\(loadToken.uuidString)") {
            await load()
        }
        // The grid, and therefore its measured height, may not exist yet the
        // first time load() finishes (it's hidden behind the loading state
        // until entries arrive) — retry centering once geometry is known.
        .onChange(of: gridViewportHeight) { _, _ in
            centerOnSpotIfNeeded()
        }
    }

    private func load() async {
        errorMessage = nil
        isLoading = true
        committedScale = 1
        committedOffset = .zero
        defer { isLoading = false }
        do {
            let window = GexHeatmapAdapters.strikeWindow(forSpotPrice: spotPrice)
            let entries: [GexHeatmapEntry]
            switch viewMode {
            case .termStructure:
                let snapshot = try await apiClient.gexTermStructure(
                    symbol: symbol,
                    expiration: selectedExpiration,
                    strikeRangeAboveSpot: window,
                    strikeRangeBelowSpot: window
                )
                (columns, entries) = GexHeatmapAdapters.columnsAndEntries(fromTermStructure: snapshot)
            case .timeSeries:
                let bucketMinutes = GexHeatmapAdapters.bucketMinutes(for: chartInterval)
                let snapshot = try await apiClient.gexHeatmap(
                    symbol: symbol,
                    expiration: timeSeriesExpiration,
                    strikeRangeAboveSpot: window,
                    strikeRangeBelowSpot: window,
                    historyWindowMinutes: GexHeatmapAdapters.historyWindowMinutes(for: bucketMinutes),
                    bucketMinutes: bucketMinutes
                )
                (columns, entries) = GexHeatmapAdapters.columnsAndEntries(fromHeatmap: snapshot)
            }
            // Sort, format, and color every cell exactly once here — not on
            // every gesture frame during a pinch/drag.
            renderedRows = GexHeatmapMath.buildRenderedRows(
                entries: entries,
                columns: columns,
                spotPrice: spotPrice
            )
            centerOnSpotIfNeeded()
        } catch {
            errorMessage = (error as? APIError)?.userMessage ?? error.localizedDescription
        }
    }

    /// Pans so the spot-price row lands vertically centered in the sheet —
    /// once per open, using the pinch/pan committed offset (this grid has no
    /// native scroll view to call scrollIntoView-equivalent on). Column
    /// (horizontal) position is left alone; only the strike axis centers.
    private func centerOnSpotIfNeeded() {
        guard !hasCenteredOnSpot else { return }
        guard !renderedRows.isEmpty,
              let index = renderedRows.firstIndex(where: \.isSpotRow)
        else { return }
        hasCenteredOnSpot = true
        let viewportRows = max(1, Int(gridViewportHeight / gridRowHeight))
        let targetTopRow = max(0, index - viewportRows / 2)
        committedOffset.height = -CGFloat(targetTopRow) * gridRowHeight
    }

    private func selectViewMode(_ mode: GexHeatmapViewMode) {
        guard mode != viewMode else { return }
        settingsStore.gexHeatmapView = mode
        viewMode = mode
        // Term structure and time series load independent row sets (a
        // strike's row index isn't stable across the switch), so the other
        // mode's committed offset doesn't correspond to the same visual
        // position here — recenter on this mode's own spot row instead of
        // reusing (or silently skipping, since `hasCenteredOnSpot` was
        // already flipped by whichever mode loaded first) a stale pan.
        hasCenteredOnSpot = false
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
                if viewMode == .timeSeries, !expirations.isEmpty {
                    expirationPicker
                }
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

    private var expirationPicker: some View {
        Menu {
            ForEach(expirations, id: \.self) { expiration in
                Button(expiration) {
                    guard expiration != timeSeriesExpiration else { return }
                    hasCenteredOnSpot = false
                    timeSeriesExpiration = expiration
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(timeSeriesExpiration ?? "Expiration")
                    .font(.system(.caption, design: .monospaced).weight(.semibold))
                Image(systemName: "chevron.down")
                    .font(.caption2)
            }
            .foregroundStyle(.white.opacity(0.85))
        }
        .accessibilityLabel("Expiration")
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
    ///
    /// Only the rows/columns actually intersecting the viewport are ever
    /// constructed (`visibleWindow` below) — every row and column is a fixed
    /// size, so the visible index range is plain arithmetic on the current
    /// pan/zoom, no measurement needed. Earlier versions built the entire
    /// strike x column matrix unconditionally (up to ~2,800 cells for a wide
    /// time-series window) and relied on `.clipped()` to hide the offscreen
    /// ones — `.clipped()` only hides drawn output, it doesn't stop SwiftUI
    /// from laying out and compositing every cell on every gesture frame,
    /// which was the real, unfixable-by-diffing-tricks cost.
    private var grid: some View {
        GeometryReader { proxy in
            let clamped = clampedOffset(proposed: offset, viewport: proxy.size)
            let window = visibleWindow(clamped: clamped, viewport: proxy.size)

            ZStack(alignment: .topLeading) {
                Color.clear
                    .onAppear { gridViewportHeight = proxy.size.height }
                    .onChange(of: proxy.size.height) { _, newValue in
                        gridViewportHeight = newValue
                    }
                GexDataBody(
                    rows: Array(renderedRows[window.rows]).map { row in
                        RenderedGexRow(
                            strike: row.strike,
                            strikeLabel: row.strikeLabel,
                            isSpotRow: row.isSpotRow,
                            cells: Array(row.cells[window.columns])
                        )
                    },
                    cellWidth: cellWidth,
                    gridRowHeight: gridRowHeight
                )
                .equatable()
                .scaleEffect(scale, anchor: .topLeading)
                .padding(.leading, strikeColumnWidth)
                .padding(.top, gridRowHeight)
                .offset(window.originOffset)
                .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
                .contentShape(Rectangle())
                .clipped()

                GexColumnHeaderRow(
                    columns: Array(columns[window.columns]),
                    cellWidth: cellWidth,
                    gridRowHeight: gridRowHeight
                )
                .equatable()
                .scaleEffect(x: scale, y: 1, anchor: .topLeading)
                .offset(x: window.originOffset.width)
                .padding(.leading, strikeColumnWidth)
                .frame(width: proxy.size.width, height: gridRowHeight, alignment: .topLeading)
                .clipped()

                GexStrikeColumn(
                    rows: Array(renderedRows[window.rows]),
                    strikeColumnWidth: strikeColumnWidth,
                    gridRowHeight: gridRowHeight
                )
                .equatable()
                .scaleEffect(x: 1, y: scale, anchor: .topLeading)
                .offset(y: window.originOffset.height)
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

    private func visibleWindow(
        clamped: CGSize,
        viewport: CGSize
    ) -> (rows: Range<Int>, columns: Range<Int>, originOffset: CGSize) {
        GexHeatmapMath.visibleWindow(
            clamped: clamped,
            viewport: viewport,
            scale: scale,
            cellWidth: cellWidth,
            rowHeight: gridRowHeight,
            rowCount: renderedRows.count,
            columnCount: columns.count
        )
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

}

/// Column-header row, extracted to its own `View` type so SwiftUI can treat
/// it as a stable subtree during a pinch/drag gesture. `GexHeatmapView.body`
/// re-evaluates every touch-move frame (its `@GestureState` changes), which
/// previously re-diffed this row's entire `ForEach` — a real cost distinct
/// from `RenderedGexRow`'s formatting/color precomputation, since here the
/// values were already precomputed and the cost was pure view-tree
/// re-evaluation. `Equatable` conformance plus `.equatable()` at the call
/// site lets SwiftUI compare inputs memberwise and skip re-invoking `body`
/// entirely when a gesture frame changes only the parent's transform, not
/// this view's actual content.
///
/// Deliberately NOT using `.drawingGroup()` here: it forces an offscreen
/// Metal render pass, and iOS Simulator's Metal path is much slower than a
/// real device's — it made both this and the data grid measurably worse
/// (near-unusable frame rate) rather than better when tested in Simulator.
/// `.equatable()` alone is what actually avoids the redundant work.
private struct GexColumnHeaderRow: View, Equatable {
    let columns: [GexHeatmapColumn]
    let cellWidth: CGFloat
    let gridRowHeight: CGFloat

    var body: some View {
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
    }
}

/// Strike column, extracted for the same reason as `GexColumnHeaderRow`.
private struct GexStrikeColumn: View, Equatable {
    let rows: [RenderedGexRow]
    let strikeColumnWidth: CGFloat
    let gridRowHeight: CGFloat

    var body: some View {
        VStack(spacing: 0) {
            ForEach(rows) { row in
                Text(row.strikeLabel)
                    .lineLimit(1)
                    .frame(width: strikeColumnWidth, height: gridRowHeight)
                    .font(.system(.caption, design: .monospaced).weight(.semibold))
                    .foregroundStyle(row.isSpotRow ? .white : .white.opacity(0.85))
                    .background(row.isSpotRow ? Color(red: 0.23, green: 0.36, blue: 0.82) : Color(white: 0.04))
            }
        }
    }
}

/// The data grid itself, extracted for the same reason as
/// `GexColumnHeaderRow` — this is the largest subtree (rows x columns) and
/// the most expensive one to re-diff per gesture frame.
private struct GexDataBody: View, Equatable {
    let rows: [RenderedGexRow]
    let cellWidth: CGFloat
    let gridRowHeight: CGFloat

    var body: some View {
        VStack(spacing: 0) {
            ForEach(rows) { row in
                dataRow(row)
            }
        }
    }

    private func dataRow(_ row: RenderedGexRow) -> some View {
        HStack(spacing: 0) {
            ForEach(row.cells) { cell in
                Text(cell.text)
                    .font(.system(.caption2, design: .monospaced).weight(.bold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .frame(width: cellWidth, height: gridRowHeight)
                    .background(cell.background)
                    .overlay(Rectangle().stroke(cell.borderColor, lineWidth: 1))
            }
        }
    }
}
