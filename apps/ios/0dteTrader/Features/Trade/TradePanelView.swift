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

    var verticalPadding: EdgeInsets {
        switch self {
        case .roomy: return EdgeInsets(top: AppSpacing.sm, leading: 0, bottom: AppSpacing.sm, trailing: 0)
        case .compact: return EdgeInsets(top: 6, leading: 0, bottom: 8, trailing: 0)
        case .dense: return EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0)
        }
    }

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

    /// Call/Put + Mid/Market segmented rows, and the AUTO contract label
    /// (desktop parity: .segmented 36 → 32 → 30px per tier).
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

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            // Upper content: clips if it exceeds available space (never scrolls).
            VStack(spacing: density.spacing) {
                positionsStrip
                    .frame(maxHeight: density.stripMaxHeight)
                // `optionsSection` dims itself piecewise: the lock chip rides in
                // its top row and must stay live, since a control that disables
                // itself cannot be used to undo the lock.
                optionsSection
                Group {
                    quantityRow
                    orderTypeRow
                }
                .disabled(tradingLocked)
                .opacity(tradingLocked ? 0.55 : 1)
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

                if chainViewModel.isAutoMode {
                    autoContractLabel
                } else {
                    strikeMenu
                }
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
            options: chainViewModel.expirations.map { HudMenuOption($0, expirationLabel($0)) },
            selection: chainViewModel.selectedExpiration,
            onSelect: { chainViewModel.selectExpiration($0) },
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

    /// The strike picker. A `HudMenu` rather than a `Menu` for the branding and
    /// for the bug: a `Menu`'s content is rebuilt on every body pass, this
    /// panel's body runs on every option-quote tick, and UIKit answers a
    /// replaced element set by resetting the presented menu — which is why a
    /// strike list long enough to scroll could not be scrolled.
    private var strikeMenu: some View {
        HudMenu(
            options: chainViewModel.strikes.map { HudMenuOption($0, Format.strike($0)) },
            selection: chainViewModel.selectedStrike,
            onSelect: { chainViewModel.selectStrike($0) },
            label: {
                chipLabel(
                    title: chainViewModel.selectedStrike.map(Format.strike) ?? "Strike",
                    systemImage: "chart.line.uptrend.xyaxis",
                    isPlaceholder: chainViewModel.selectedStrike == nil
                )
            }
        )
        .accessibilityLabel("Strike")
    }

    private var autoContractLabel: some View {
        HStack {
            if chainViewModel.isLoading {
                ProgressView()
                    .controlSize(.small)
            } else if let contract = chainViewModel.autoContract {
                Text("\(Format.strike(contract.strike))\(contract.optionType.shortName)")
                    .font(.priceMedium)
                Text(contract.mid.map { "≈ \(Format.price($0))" } ?? "—")
                    .font(.priceSmall)
                    .foregroundStyle(.secondary)
            } else {
                Text("No contract")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, minHeight: density.segmentedMinHeight)
        .padding(.horizontal, 10)
        .background {
            HudPanelShape(chamfer: 6)
                .fill(Color.appSurface)
                .overlay {
                    HudPanelShape(chamfer: 6)
                        .strokeBorder(Color.hudStroke.opacity(0.35), lineWidth: 1)
                }
        }
    }

    // MARK: - Quantity & order type

    private var quantityRow: some View {
        HStack(spacing: AppSpacing.md) {
            Text("Qty")
                .font(.panelLabel)
                .foregroundStyle(.secondary)

            Button {
                Haptics.selection()
                tradeViewModel.addQuantity(-1)
            } label: {
                Image(systemName: "minus")
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

    private var orderTypeRow: some View {
        HStack(spacing: AppSpacing.md) {
            HudSegmentedControl(
                options: [
                    .init(OrderType.mid, "Mid"),
                    .init(OrderType.market, "Market"),
                ],
                selection: $tradeViewModel.orderType,
                minHeight: density.segmentedMinHeight
            )
            .accessibilityLabel("Order type")

            if let line = quoteLine {
                Text(line)
                    .font(.priceSmall)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .layoutPriority(1)
            }
        }
    }

    private var quoteLine: String? {
        guard let contract = chainViewModel.selectedContract else { return nil }
        if tradeViewModel.orderType == .mid, let mid = contract.mid {
            return "≈ \(Format.price(mid))"
        }
        return "\(Format.price(contract.bid)) × \(Format.price(contract.ask))"
    }

    private var canTrade: Bool {
        chainViewModel.selectedContract != nil && !tradingLocked
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
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Spacer()
            Button("Retry", action: retry)
                .font(.chipLabel)
                .foregroundStyle(Color.appAccent)
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
        isPlaceholder: Bool = false,
        fillWidth: Bool = true
    ) -> some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage)
                .font(.caption)
                .accessibilityHidden(true)
            Text(title)
                .font(.system(.caption, design: .monospaced).weight(.semibold))
                .foregroundStyle(isPlaceholder ? .secondary : .primary)
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
        }
        .foregroundStyle(isPlaceholder ? .secondary : .primary)
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
    }
}
