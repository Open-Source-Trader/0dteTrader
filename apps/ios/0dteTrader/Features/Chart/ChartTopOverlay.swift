import SwiftUI

/// The quote readout laid over the price pane's first line, centred between the
/// symbol menu and the mode badge — the TradingView arrangement, where the
/// numbers label the candles they belong to instead of sitting in a separate
/// bar above them.
///
/// Last price and percent change only. The bid/ask pair and the absolute change
/// were the width that forced this block into a plate of its own; without them
/// it is short enough to sit on the candles unbacked, which is what keeps the
/// chart reading as one surface. A dark drop shadow does the legibility work a
/// black box used to.
///
/// It never takes touches: the pane below answers a single tap with the
/// placement guide and a triple tap with the fullscreen toggle, and a readout
/// that swallowed either would be a trading control lost to a label.
struct ChartQuoteReadout: View {
    let quote: Quote
    /// Change vs the session open, already computed by the view model.
    let dayChange: (change: Double, percent: Double)?
    /// Ticks into the candle being built; it rode in the header with the price
    /// and follows it here rather than crowding the consolidated top bar.
    let tickProgress: TickProgress?

    var body: some View {
        VStack(spacing: 1) {
            HStack(spacing: AppSpacing.xs) {
                Text(Format.price(quote.last))
                    .font(.priceMedium.weight(.semibold))
                    .shadow(color: .hudGlow, radius: 6)
                if let dayChange {
                    Text("(\(String(format: "%+.2f", dayChange.percent))%)")
                        .font(.priceSmall.weight(.medium))
                        .foregroundStyle(dayChange.change >= 0 ? Color.pnlPositive : Color.pnlNegative)
                        // VoiceOver still hears the dollar move: it is the
                        // number a trader acts on, and dropping it from the
                        // display is a density decision, not an editorial one.
                        .accessibilityLabel(dayChange.change >= 0
                            ? "Up \(Format.price(dayChange.change)) today"
                            : "Down \(Format.price(abs(dayChange.change))) today")
                }
            }
            if let tickProgress {
                Text("\(tickProgress.count)/\(tickProgress.size) ticks")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(Color.secondary)
                    .accessibilityLabel(
                        "Building candle: \(tickProgress.count) of \(tickProgress.size) ticks"
                    )
            }
        }
        // Candles run under these numbers now that the plate is gone; a tight
        // black shadow separates them from a wick without printing a box.
        .shadow(color: .black.opacity(0.85), radius: 3)
        // Centred on the pane, the readout is boxed off the chip groups either
        // side of it rather than allowed to run under one, so on a narrow pane
        // it has to be able to give ground. Scaling first, truncating only past
        // the floor: a partly-shrunk price is still a price.
        .lineLimit(1)
        .minimumScaleFactor(0.7)
        .allowsHitTesting(false)
    }
}

/// Metrics the controls on the pane's first line share, so the four chips and
/// the mode badge read as one row rather than as five separately sized things.
enum ChartChip {
    /// The mode badge's type, adopted by the rest of the row.
    static let font = Font.custom("Orbitron-Bold", size: 11, relativeTo: .caption2)
    static let chamfer: CGFloat = 6
    /// Glyph box for the two icon chips. The width evens their chips out
    /// against the text ones; the height is Orbitron's line box at 11pt, so an
    /// icon chip and a text chip come out the same height on the row.
    static let iconSize: CGFloat = 11
    static let iconBox = CGSize(width: 14, height: 14)

    /// Fill, stroke strength and label colour, named once here because the
    /// corner controls seated on the same pane wear them too — the `A` reset
    /// buttons used to carry a hand-copied fill, a stronger stroke and a 0.7
    /// dim, which is why they read duller than the row above them.
    ///
    /// The label is the panel's grey rather than the accent: the chrome text
    /// across this screen is one colour now, and the blue is left to the
    /// borders it draws.
    static let fill = Color.hudPanel
    static let strokeOpacity: Double = 0.35
    static let label = Color.secondary
}

/// Width of the widest chip group on the pane's first line.
///
/// The quote readout is centred on the pane rather than in the gap the two
/// groups leave — they are no longer the same width, and the midline is what
/// "the middle of the top" means. Centring alone would let the readout run
/// under a chip on a narrow pane, so it is inset by this on *both* sides: the
/// widest group's width is the smallest symmetric inset that clears both.
struct ChipGroupWidthKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

extension View {
    /// Reports this group's laid-out width up to `ChipGroupWidthKey`, which
    /// reduces by `max` — so both groups report and the reader gets the wider.
    func measuringChipGroup() -> some View {
        background {
            GeometryReader { proxy in
                Color.clear.preference(key: ChipGroupWidthKey.self, value: proxy.size.width)
            }
        }
    }

    /// The chrome every chip on the pane's first line wears: opaque, because it
    /// sits over candles rather than over a card's fill, and chamfered parallel
    /// to the card's own corner cut.
    ///
    /// `strokeOpacity` is the one thing that varies — the symbol menu keeps the
    /// brighter border it had, since it is the control that changes what you
    /// are looking at.
    func chartChipChrome(
        strokeOpacity: Double = ChartChip.strokeOpacity,
        lineWidth: CGFloat = 1
    ) -> some View {
        padding(.horizontal, AppSpacing.sm)
            .padding(.vertical, AppSpacing.xs)
            .background {
                HudPanelShape(chamfer: ChartChip.chamfer)
                    .fill(ChartChip.fill)
                    .overlay {
                        HudPanelShape(chamfer: ChartChip.chamfer)
                            .strokeBorder(Color.hudStroke.opacity(strokeOpacity), lineWidth: lineWidth)
                    }
            }
            // This box, not the 44pt target wrapped around it below, is what a
            // popup opened from this chip hangs from.
            .hudMenuAnchorSource()
    }

    /// The chips' chrome on a corner control's own square geometry — the `A`
    /// reset buttons seated in the price pane's and the sub-panes' bottom-right
    /// corners.
    ///
    /// Same fill, same stroke, same label colour, read from `ChartChip` rather
    /// than restated, so "the reset button matches the chips" cannot quietly
    /// stop being true. What is *not* shared is the silhouette: the pane's `A`
    /// sits at an inset `ChartMetrics.cornerSeat` derives from its corner
    /// radius, and it stands in one column with the placement guide's `+`, so
    /// its box stays the rounded square that arithmetic describes.
    func chartCornerControlChrome(size: CGFloat, cornerRadius: CGFloat) -> some View {
        foregroundStyle(ChartChip.label)
            .frame(width: size, height: size)
            .background(ChartChip.fill, in: RoundedRectangle(cornerRadius: cornerRadius))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius)
                    .strokeBorder(
                        Color.hudStroke.opacity(ChartChip.strokeOpacity),
                        lineWidth: 1
                    )
            )
    }

    /// Grows a chip's touch target to the 44pt minimum without growing the chip.
    ///
    /// The chips are the mode badge's height now — about 22pt drawn — so each
    /// one sits at the top of a 44pt box and the slack hangs below it, over
    /// candles nothing else claims. Top-aligned rather than centred so the row
    /// still hugs the card's top border; a `contentShape` on a negative padding
    /// was the other way to do this, and SwiftUI clips hit-testing to the
    /// laid-out frame, so it silently gave the chip back its 22pt.
    ///
    /// `minHeight`, not `height`: at the larger Dynamic Type sizes the chip
    /// outgrows 44pt and must be allowed to.
    func chartChipTouchTarget() -> some View {
        frame(minHeight: AppOrderLine.minimumTouchTarget, alignment: .top)
            .contentShape(Rectangle())
    }
}

/// Symbol menu, moved off the header and onto the pane's top-leading corner so
/// it answers the mode badge at the opposite one. Both sit `AppSpacing.sm` off
/// their two borders; this chip's own chamfer runs parallel to the card's, so
/// at 8pt in from each border it still clears the corner cut by 8.5pt.
///
/// Sized to the mode badge exactly — same type, same padding — so the two ends
/// of the row match. The 44pt target the old 36pt box gave it is kept as hit
/// area rather than as height; nothing about the control that changes what you
/// are trading gets harder to hit.
///
/// The picker was a half-height sheet and is a dropdown now, opening under this
/// chip like the interval menu beside it. It keeps everything the sheet had —
/// the search field, the curated sections, the recents, arbitrary tickers — so
/// it is the one popup that does not size to its widest row: a search field a
/// strike-list wide is a search field you cannot read your own query in.
struct ChartSymbolButton: View {
    let symbol: String
    let onSelect: (String) -> Void

    var body: some View {
        HudMenuTrigger(
            id: "chart.symbol",
            edge: .leading,
            content: { dismiss in
                AnyView(
                    SymbolSearchView(
                        currentSymbol: symbol,
                        onSelect: onSelect,
                        onDismiss: dismiss
                    )
                )
            },
            label: {
                HStack(spacing: AppSpacing.xs) {
                    Text(symbol)
                        .font(ChartChip.font)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 8, weight: .bold))
                }
                .foregroundStyle(ChartChip.label)
                .chartChipChrome(strokeOpacity: 0.6, lineWidth: 1.2)
                .chartChipTouchTarget()
            }
        )
        .accessibilityLabel("Change symbol")
        .accessibilityValue(symbol)
    }
}

/// Interval menu, moved out of the header and onto the chip row. A `HudMenu`
/// rather than a `Menu`: the timeframe popup is a control the eye lands on
/// several times a session, and a system-grey card is the one thing on this
/// screen that does not belong to it.
struct ChartIntervalMenu: View {
    let interval: AnyChartInterval
    let onSelect: (AnyChartInterval) -> Void

    var body: some View {
        HudMenu(
            id: "chart.interval",
            options: AnyChartInterval.allCases.map { HudMenuOption($0, $0.rawValue.uppercased()) },
            selection: interval,
            onSelect: onSelect,
            // Leading: the chip is at the pane's leading corner, and the popup
            // lines up under the column it came out of.
            edge: .leading
        ) {
            Text(interval.rawValue.uppercased())
                .font(ChartChip.font)
                .foregroundStyle(ChartChip.label)
                .chartChipChrome()
                .chartChipTouchTarget()
        }
        .accessibilityLabel("Chart interval")
        .accessibilityValue(interval.rawValue)
    }
}

/// Indicator-settings button. It wore a circle in the header; on the chip row
/// it takes the interval menu's chamfered border like everything else.
struct ChartIndicatorButton: View {
    let action: () -> Void

    var body: some View {
        Button {
            Haptics.selection()
            action()
        } label: {
            Image(systemName: "slider.horizontal.3")
                .font(.system(size: ChartChip.iconSize, weight: .semibold))
                .foregroundStyle(ChartChip.label)
                .frame(minWidth: ChartChip.iconBox.width, minHeight: ChartChip.iconBox.height)
                .chartChipChrome()
                .chartChipTouchTarget()
        }
        .accessibilityLabel("Indicator settings")
    }
}

/// Drawing-tools dropdown (TradingView-style annotations), last on the chip row.
///
/// The armed state is carried by the glyph and its color rather than by a
/// filled circle: on the chip row a solid accent disc was the one control that
/// did not read as part of the set.
struct ChartDrawingToolsMenu: View {
    @ObservedObject var drawings: ChartDrawingsModel
    @State private var showClearConfirm = false

    var body: some View {
        HudMenu(
            id: "chart.drawingTools",
            options: DrawingTool.allCases.map {
                HudMenuOption($0, $0.title, systemImage: $0.systemImage)
            },
            selection: drawings.tool,
            onSelect: { drawings.tool = $0 },
            destructive: drawings.hasAnnotations
                ? (
                    drawings.selectedId != nil ? "Delete Selection" : "Clear All Drawings",
                    {
                        if drawings.selectedId != nil {
                            drawings.removeSelectedOrClear()
                        } else {
                            showClearConfirm = true
                        }
                    }
                )
                : nil,
            // Trailing: this chip lives on the pane's trailing corner, so its
            // popup comes down that side rather than crossing the chart.
            edge: .trailing,
            label: {
                let glyph = drawings.tool == .cursor ? "pencil.and.outline" : drawings.tool.systemImage
                Image(systemName: glyph)
                    .font(.system(size: ChartChip.iconSize, weight: .semibold))
                    // Amber stays: it is not chrome colour but the armed
                    // state of a tool that changes what a drag on the chart
                    // does, and the row has no other way to say so.
                    .foregroundStyle(drawings.tool == .cursor ? ChartChip.label : Color.hudAmber)
                    .frame(minWidth: ChartChip.iconBox.width, minHeight: ChartChip.iconBox.height)
                    .chartChipChrome()
                    .chartChipTouchTarget()
            }
        )
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

/// Options-structure quality chip. It shared the top-leading corner with
/// nothing before the quote readout arrived; now it stacks directly beneath
/// the readout, which is where TradingView keeps indicator legends and the
/// only place that neither collides with the price line nor with the analytics
/// error pinned to the bottom-leading corner.
struct ChartStructChip: View {
    let snapshot: OptionsAnalyticsSnapshotDTO
    let displayState: OptionsAnalyticsDisplayState
    let settings: OptionsAnalyticsSettings
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Text("STRUCT")
                Text(snapshot.quality.status.rawValue.uppercased())
                if displayState == .retained {
                    Text("RETAINED")
                }
                if settings.showDiagnostics && !snapshot.quality.warnings.isEmpty {
                    Image(systemName: "exclamationmark.triangle.fill")
                }
            }
            .font(.system(size: 8, weight: .bold, design: .monospaced))
            .foregroundStyle(
                snapshot.quality.warnings.isEmpty || !settings.showDiagnostics
                    ? ChartChip.label
                    : Color.appWarning
            )
            .padding(.horizontal, 6)
            .frame(minHeight: 28)
            .background(Color.black.opacity(0.72))
            .clipShape(Capsule())
        }
        .accessibilityLabel(
            OptionsAnalyticsPresentation.accessibilitySummary(
                snapshot: snapshot,
                settings: settings
            )
        )
        .accessibilityHint("Shows options structure details")
    }
}
