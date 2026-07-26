import SwiftUI

/// Density tiers matching the desktop (Electron) panel compaction:
/// roomy (0 sub-panes), compact (1), dense (2). The panel's fixed height
/// shrinks as sub-panes appear; content compacts to fit — it never scrolls.
enum TradePanelDensity: Sendable {
    case roomy, compact, dense

    var spacing: CGFloat {
        switch self {
        case .roomy: return AppSpacing.sm
        case .compact: return 6
        case .dense: return 4
        }
    }

    /// The panel's own inset. The top half is deliberately half the bottom: it
    /// is one of the two terms in the distance from the chart's bottom border
    /// to the panel's first control, and that distance was reading as a gulf.
    /// The bottom is unchanged — it sits under SELL/BUY, where the space is
    /// separating the buttons from the home indicator rather than joining two
    /// surfaces.
    var verticalPadding: EdgeInsets {
        switch self {
        case .roomy: return EdgeInsets(top: AppSpacing.xs, leading: 0, bottom: AppSpacing.sm, trailing: 0)
        case .compact: return EdgeInsets(top: 3, leading: 0, bottom: 8, trailing: 0)
        case .dense: return EdgeInsets(top: 2, leading: 0, bottom: 4, trailing: 0)
        }
    }

    /// Gap above the panel's first control row — the other term in that same
    /// distance, and the reason halving `spacing` outright was the wrong knob:
    /// `spacing` also sets every gap *between* the panel's rows and the pad
    /// above SELL/BUY, none of which the chart is anywhere near.
    var firstRowSpacing: CGFloat { (spacing / 2).rounded() }

    var stripMaxHeight: CGFloat {
        switch self {
        case .roomy: return 140
        case .compact: return 100
        case .dense: return 64
        }
    }

    var buttonMinHeight: CGFloat {
        switch self {
        case .roomy: return 50
        case .compact: return 44
        case .dense: return 40
        }
    }

    /// Call/Put + Mid/Market segmented rows (desktop parity: .segmented
    /// 36 → 32 → 30px per tier). The AUTO contract used to be pinned to this
    /// too, which is what made the contract row change height with the toggle;
    /// it wears the strike chip now and takes `chipMinHeight` like its twin.
    var segmentedMinHeight: CGFloat {
        switch self {
        case .roomy: return 34
        case .compact: return 32
        case .dense: return 30
        }
    }

    /// Expiration/strike chip triggers (desktop parity: .chip-button
    /// vertical padding 8 → 6 → 5px per tier).
    var chipVerticalPadding: CGFloat {
        switch self {
        case .roomy: return 11
        case .compact: return 6
        case .dense: return 5
        }
    }

    var chipMinHeight: CGFloat {
        switch self {
        case .roomy: return 44
        case .compact: return 32
        case .dense: return 30
        }
    }

    /// Quantity stepper − / + buttons: the visible chamfered square
    /// (desktop parity: .stepper 36 → 32 → 30px per tier).
    var stepperVisualSize: CGFloat {
        switch self {
        case .roomy: return 34
        case .compact: return 32
        case .dense: return 30
        }
    }

    /// The stepper's touch frame — scaled with the visual so the row
    /// actually compacts instead of pinning the row at 44pt.
    var stepperTouchSize: CGFloat {
        switch self {
        case .roomy: return 44
        case .compact: return 40
        case .dense: return 36
        }
    }

    /// +1/+5/+10 quick chips. The stepper's *visible* square, not its touch
    /// frame: the three chips and the − / + buttons read as one run of controls
    /// across the quantity row, and one run of controls is one height. They
    /// keep a 44pt target the same way the stepper does — as hit area around
    /// the drawn box rather than as the box.
    var quickChipMinHeight: CGFloat { stepperVisualSize }
}

/// Layout B's bottom trade panel (FR-13..18): option type / expiration /
/// strike / AUTO contract selection, quantity quick-steppers, mid/market
/// toggle, and Buy/Sell arm buttons. Options-only.
/// The panel is sized to fit its content at every density — it never scrolls.
struct TradePanelView: View {
    @ObservedObject var tradeViewModel: TradeViewModel
    @ObservedObject var chainViewModel: OptionsChainViewModel
    let underlying: String
    let positionsStrip: PositionsStripView
    var density: TradePanelDensity = .roomy
    /// Trading lock: disables Buy/Sell and the order-config controls. The
    /// positions strip handles its own lock (passed in pre-built).
    var tradingLocked: Bool = false
    let onArm: (OrderSide) -> Void
    /// Flips the trading lock. A closure rather than a binding: the lock is
    /// persisted upstream, and the panel only ever asks for the flip.
    var onToggleLock: () -> Void = {}
    var onShowAIAnalysis: () -> Void = {}
    /// Passed straight through to the pricing row, which raises it while its
    /// price field holds the keyboard. The screen above needs it, and the panel
    /// is only the wire — see `OrderPricingRow.isEditingPrice`.
    @Binding var isEditingPrice: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            // Upper content: clips if it exceeds available space (never scrolls).
            //
            // Split into two stacks rather than one so the gap above the first
            // control can differ from the gaps between the rows below it. With
            // no open positions the strip is zero-height, which makes that first
            // gap the last leg of the run from the chart's bottom border to the
            // lock chip — a seam between two surfaces, not a row separator.
            VStack(spacing: 0) {
                positionsStrip
                    .frame(maxHeight: density.stripMaxHeight)
                    // Pinned to its own height, and this is load-bearing. The
                    // stack above it takes every point the panel has left over
                    // so SELL/BUY stay on the floor, and SwiftUI hands that
                    // slack to whichever child can grow — `maxHeight` alone
                    // says this one can, by up to 140pt. With no open positions
                    // the strip is empty, so it was quietly inflating to
                    // whatever was going spare and pushing the first control
                    // row down by that much. Every point trimmed from the two
                    // paddings above went straight back into the strip, which
                    // is why the gap would not close.
                    .fixedSize(horizontal: false, vertical: true)
                VStack(spacing: density.spacing) {
                    // `optionsSection` dims itself piecewise: the lock chip rides
                    // in its top row and must stay live, since a control that
                    // disables itself cannot be used to undo the lock.
                    optionsSection
                    Group {
                        quantityRow
                        OrderPricingRow(
                            tradeViewModel: tradeViewModel,
                            chainViewModel: chainViewModel,
                            density: density,
                            isEditingPrice: $isEditingPrice
                        )
                    }
                    .disabled(tradingLocked)
                    .opacity(tradingLocked ? 0.55 : 1)
                }
                .padding(.top, density.firstRowSpacing)
            }
            .frame(maxHeight: .infinity, alignment: .top)
            .clipped()

            // Action buttons pinned to the bottom — always visible regardless
            // of how much content is above (desktop parity: marginTop: auto).
            HStack(spacing: AppSpacing.md) {
                TradeActionButton(title: "SELL", color: .sellRed, isEnabled: canTrade) {
                    onArm(.sell)
                }
                .frame(minHeight: density.buttonMinHeight)
                TradeActionButton(title: "BUY", color: .buyGreen, isEnabled: canTrade) {
                    onArm(.buy)
                }
                .frame(minHeight: density.buttonMinHeight)
            }
            .padding(.top, density.spacing)
            .layoutPriority(1)
            // The box the order confirmation opens out of.
            .tradeActionsAnchorSource()
        }
        .padding(.horizontal, AppSpacing.md)
        .padding(density.verticalPadding)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(reduceMotion ? nil : .snappy(duration: 0.22, extraBounce: 0), value: chainViewModel.isAutoMode)
        .background(Color.appBackground)
    }

    // MARK: - Options

    private var optionsSection: some View {
        VStack(spacing: AppSpacing.sm) {
            if let message = chainViewModel.errorMessage {
                errorRow(message) {
                    Task { await chainViewModel.load(underlying: underlying) }
                }
            }

            HStack(spacing: AppSpacing.sm) {
                // The lock leads the row, ahead of the controls it disables,
                // and stays outside the wrapper that disables them: a control
                // that switched itself off could not be used to switch back.
                lockChip

                Group {
                    HudSegmentedControl(
                        options: [
                            .init(OptionType.call, "Call", accent: .buyGreen),
                            .init(OptionType.put, "Put", accent: .sellRed),
                        ],
                        selection: $chainViewModel.optionType,
                        minHeight: density.segmentedMinHeight
                    )
                    .accessibilityLabel("Option type")

                    HudToggleChip(
                        title: "AUTO",
                        isOn: $chainViewModel.isAutoMode,
                        accent: .appAccent
                    )
                    .accessibilityLabel("Auto +1 OTM selection")
                }
                .disabled(tradingLocked)
                .opacity(tradingLocked ? 0.55 : 1)

                AIAnalysisButton(action: onShowAIAnalysis)
            }

            HStack(spacing: AppSpacing.sm) {
                expirationMenu
                strikeSlot
            }
            .disabled(tradingLocked)
            .opacity(tradingLocked ? 0.55 : 1)
        }
    }

    /// Trading lock, styled as the on/off chip it is. Red rather than amber:
    /// locked is the state that refuses orders.
    private var lockChip: some View {
        HudToggleChip(
            // Icon only: an open or closed padlock is not ambiguous, and the
            // accessibility label below carries the meaning for anyone it is.
            title: nil,
            isOn: Binding(get: { tradingLocked }, set: { _ in onToggleLock() }),
            accent: .sellRed,
            icon: "lock.open.fill",
            onIcon: "lock.fill"
        )
        .accessibilityLabel(tradingLocked ? "Unlock trading" : "Lock trading")
    }

    private var expirationMenu: some View {
        HudMenu(
            id: "panel.expiration",
            options: chainViewModel.expirations.map { HudMenuOption($0, expirationLabel($0)) },
            selection: chainViewModel.selectedExpiration,
            onSelect: { chainViewModel.selectExpiration($0) },
            // The two chips split this row, and each popup comes down the side
            // of the screen its chip sits on.
            edge: .leading,
            label: {
                chipLabel(
                    title: chainViewModel.selectedExpiration.map(expirationLabel) ?? "Expiration",
                    systemImage: "calendar",
                    isPlaceholder: chainViewModel.selectedExpiration == nil
                )
            }
        )
        .accessibilityLabel("Expiration")
    }

    private func expirationLabel(_ expiration: String) -> String {
        // 0DTE is an exchange-calendar concept: compare in New York time.
        if expiration == DateParsing.marketDayString(from: Date()) {
            return "\(expiration) · 0DTE"
        }
        return expiration
    }

    /// The strike side of the contract row, in either mode.
    ///
    /// It used to be two unrelated views: the menu trigger below, built by
    /// `chipLabel` with the chip's own vertical padding and `chipMinHeight`
    /// floor (44pt when roomy), and — with AUTO on — a plain label pinned to
    /// `segmentedMinHeight` (34pt). *That* is why the row changed height with
    /// the toggle; nothing was wrapping or clipping. Both states are the same
    /// chip now, so this half always matches the expiration half beside it, and
    /// both carry the contract's mid.
    @ViewBuilder
    private var strikeSlot: some View {
        if chainViewModel.isAutoMode {
            autoContractChip
        } else {
            strikeMenu
        }
    }

    /// The strike picker. A `HudMenu` rather than a `Menu` for the branding and
    /// for the bug: a `Menu`'s content is rebuilt on every body pass, this
    /// panel's body runs on every option-quote tick, and UIKit answers a
    /// replaced element set by resetting the presented menu — which is why a
    /// strike list long enough to scroll could not be scrolled.
    private var strikeMenu: some View {
        HudMenu(
            id: "panel.strike",
            options: chainViewModel.strikes.map { HudMenuOption($0, Format.strike($0)) },
            selection: chainViewModel.selectedStrike,
            onSelect: { chainViewModel.selectStrike($0) },
            edge: .trailing,
            label: {
                chipLabel(
                    title: chainViewModel.selectedStrike.map(Format.strike) ?? "Strike",
                    systemImage: "chart.line.uptrend.xyaxis",
                    detail: midDetail,
                    isPlaceholder: chainViewModel.selectedStrike == nil
                )
            }
        )
        .accessibilityLabel("Strike")
    }

    /// AUTO's pick, wearing the strike chip it stands in for. Not a control:
    /// AUTO is what chooses, so there is nothing here to open.
    private var autoContractChip: some View {
        Group {
            if chainViewModel.isLoading {
                chipLabel(
                    title: "Loading…",
                    systemImage: "chart.line.uptrend.xyaxis",
                    isPlaceholder: true
                )
            } else if let contract = chainViewModel.autoContract {
                chipLabel(
                    title: "\(Format.strike(contract.strike))\(contract.optionType.shortName)",
                    systemImage: "chart.line.uptrend.xyaxis",
                    detail: midDetail
                )
            } else {
                chipLabel(
                    title: "No contract",
                    systemImage: "chart.line.uptrend.xyaxis",
                    isPlaceholder: true
                )
            }
        }
        .accessibilityLabel("Auto-selected contract")
    }

    /// The mid printed beside the strike, in either mode — `selectedContract`
    /// already resolves to AUTO's pick when AUTO is on.
    private var midDetail: String? {
        guard let contract = chainViewModel.selectedContract else { return nil }
        return contract.mid.map { "≈ \(Format.price($0))" } ?? "—"
    }

    // MARK: - Quantity & order pricing

    private var quantityRow: some View {
        HStack(spacing: AppSpacing.md) {
            Text("Qty")
                .font(.panelLabel)
                .foregroundStyle(Color.secondary)

            Button {
                Haptics.selection()
                tradeViewModel.addQuantity(-1)
            } label: {
                Image(systemName: "minus")
                    .foregroundStyle(Color.secondary)
                    .frame(width: density.stepperTouchSize, height: density.stepperTouchSize)
                    .background {
                        HudPanelShape(chamfer: 5)
                            .fill(Color.hudPanel)
                            .overlay {
                                HudPanelShape(chamfer: 5)
                                    .strokeBorder(Color.hudStroke.opacity(0.35), lineWidth: 1)
                            }
                            .frame(width: density.stepperVisualSize, height: density.stepperVisualSize)
                    }
                    .contentShape(Rectangle())
            }
            .buttonStyle(AppPressStyle())
            .accessibilityLabel("Decrease quantity")

            Text("\(tradeViewModel.quantity)")
                .font(.priceMedium)
                .foregroundStyle(Color.secondary)
                .shadow(color: .hudGlow, radius: 6)
                .frame(minWidth: 36)
                .accessibilityLabel("Quantity")
                .accessibilityValue("\(tradeViewModel.quantity)")
                .accessibilityAdjustableAction { direction in
                    switch direction {
                    case .increment: tradeViewModel.addQuantity(1)
                    case .decrement: tradeViewModel.addQuantity(-1)
                    @unknown default: break
                    }
                }

            Button {
                Haptics.selection()
                tradeViewModel.addQuantity(1)
            } label: {
                Image(systemName: "plus")
                    .foregroundStyle(Color.secondary)
                    .frame(width: density.stepperTouchSize, height: density.stepperTouchSize)
                    .background {
                        HudPanelShape(chamfer: 5)
                            .fill(Color.hudPanel)
                            .overlay {
                                HudPanelShape(chamfer: 5)
                                    .strokeBorder(Color.hudStroke.opacity(0.35), lineWidth: 1)
                            }
                            .frame(width: density.stepperVisualSize, height: density.stepperVisualSize)
                    }
                    .contentShape(Rectangle())
            }
            .buttonStyle(AppPressStyle())
            .accessibilityLabel("Increase quantity")

            Spacer()

            // Drawn at the stepper's size, targeted at the stepper's target:
            // the five controls on this row are one set and compact together.
            ForEach([1, 5, 10], id: \.self) { step in
                QuickChipButton(
                    title: "+\(step)",
                    minHeight: density.quickChipMinHeight,
                    touchHeight: density.stepperTouchSize
                ) {
                    tradeViewModel.addQuantity(step)
                }
            }
        }
    }

    private var canTrade: Bool {
        // Custom with nothing typed in it has no price to send, and the server
        // would refuse the request anyway.
        chainViewModel.selectedContract != nil && !tradingLocked && tradeViewModel.canArm
    }

    // MARK: - Shared chrome

    /// Inline load-error row with a retry action (chain load failures).
    private func errorRow(_ message: String, retry: @escaping () -> Void) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Color.pnlNegative)
                .accessibilityHidden(true)
            Text(message)
                .font(.caption)
                .foregroundStyle(Color.secondary)
                .lineLimit(2)
            Spacer()
            Button("Retry", action: retry)
                .font(.chipLabel)
                .foregroundStyle(Color.secondary)
        }
        .padding(.horizontal, AppSpacing.md)
        .padding(.vertical, AppSpacing.sm)
        .background {
            HudPanelShape(chamfer: 6)
                .fill(Color.appSurface)
                .overlay {
                    HudPanelShape(chamfer: 6)
                        .strokeBorder(Color.sellRed, lineWidth: 1)
                }
                .compositingGroup()
                .shadow(color: Color.sellRed.opacity(0.35), radius: 5)
        }
    }

    private func chipLabel(
        title: String,
        systemImage: String,
        /// Trailing readout inside the same chip — the contract's mid, which
        /// both halves of the strike slot now print.
        detail: String? = nil,
        isPlaceholder: Bool = false,
        fillWidth: Bool = true
    ) -> some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage)
                .font(.caption)
                .accessibilityHidden(true)
            Text(title)
                .font(.system(.caption, design: .monospaced).weight(.semibold))
                .lineLimit(1)
                // Both chips on this row take `maxWidth: .infinity`, which an
                // HStack divides evenly — but only for as long as neither
                // child's *minimum* exceeds its half. A single line with no
                // scale floor has a minimum of its full width, so
                // "2026-07-26 · 0DTE" (the expiration this app exists for) used
                // to claim more than half the row and leave the strike chip
                // visibly narrower. With a floor the minimum is a fraction of
                // that and the two always come out the same size.
                .minimumScaleFactor(0.6)
            if let detail {
                Text(detail)
                    .font(.priceSmall)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
            }
        }
        // One grey for the whole chip. The placeholder flag no longer changes
        // the colour — the panel's chrome text is all `.secondary` now — but it
        // still marks "nothing chosen yet" for the dimming below.
        .foregroundStyle(Color.secondary)
        .opacity(isPlaceholder ? 0.7 : 1)
        .padding(.horizontal, AppSpacing.md)
        .padding(.vertical, density.chipVerticalPadding)
        .frame(maxWidth: fillWidth ? .infinity : nil, minHeight: density.chipMinHeight)
        .background {
            HudPanelShape(chamfer: 6)
                .fill(Color.hudPanel)
                .overlay {
                    HudPanelShape(chamfer: 6)
                        .strokeBorder(Color.hudStroke.opacity(0.35), lineWidth: 1)
                }
        }
        // The box a popup opened from this chip hangs from.
        .hudMenuAnchorSource()
    }
}
