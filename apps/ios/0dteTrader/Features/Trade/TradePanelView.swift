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
    let onArm: (OrderSide) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            // Upper content: clips if it exceeds available space (never scrolls).
            VStack(spacing: density.spacing) {
                positionsStrip
                    .frame(maxHeight: density.stripMaxHeight)
                optionsSection
                quantityRow
                orderTypeRow
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
                HudSegmentedControl(
                    options: [
                        .init(OptionType.call, "Call", accent: .buyGreen),
                        .init(OptionType.put, "Put", accent: .sellRed),
                    ],
                    selection: $chainViewModel.optionType
                )
                .accessibilityLabel("Option type")

                HudToggleChip(
                    title: "AUTO",
                    isOn: $chainViewModel.isAutoMode,
                    accent: .appAccent
                )
                .accessibilityLabel("Auto +1 OTM selection")
            }

            HStack(spacing: AppSpacing.sm) {
                expirationMenu

                if chainViewModel.isAutoMode {
                    autoContractLabel
                } else {
                    strikeMenu
                }
            }
        }
    }

    private var expirationMenu: some View {
        Menu {
            ForEach(chainViewModel.expirations, id: \.self) { expiration in
                Button {
                    chainViewModel.selectExpiration(expiration)
                } label: {
                    HStack {
                        Text(expirationLabel(expiration))
                        if expiration == chainViewModel.selectedExpiration {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
        } label: {
            chipLabel(
                title: chainViewModel.selectedExpiration.map(expirationLabel) ?? "Expiration",
                systemImage: "calendar",
                isPlaceholder: chainViewModel.selectedExpiration == nil
            )
        }
    }

    private func expirationLabel(_ expiration: String) -> String {
        // 0DTE is an exchange-calendar concept: compare in New York time.
        if expiration == DateParsing.marketDayString(from: Date()) {
            return "\(expiration) · 0DTE"
        }
        return expiration
    }

    private var strikeMenu: some View {
        Menu {
            ForEach(chainViewModel.strikes, id: \.self) { strike in
                Button(Format.strike(strike)) {
                    chainViewModel.selectStrike(strike)
                }
            }
        } label: {
            chipLabel(
                title: chainViewModel.selectedStrike.map(Format.strike) ?? "Strike",
                systemImage: "chart.line.uptrend.xyaxis",
                isPlaceholder: chainViewModel.selectedStrike == nil
            )
        }
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
        .frame(maxWidth: .infinity, minHeight: 34)
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
                    .frame(width: 44, height: 44)
                    .background {
                        HudPanelShape(chamfer: 5)
                            .fill(Color.hudPanel)
                            .overlay {
                                HudPanelShape(chamfer: 5)
                                    .strokeBorder(Color.hudStroke.opacity(0.35), lineWidth: 1)
                            }
                            .frame(width: 34, height: 34)
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
                    .frame(width: 44, height: 44)
                    .background {
                        HudPanelShape(chamfer: 5)
                            .fill(Color.hudPanel)
                            .overlay {
                                HudPanelShape(chamfer: 5)
                                    .strokeBorder(Color.hudStroke.opacity(0.35), lineWidth: 1)
                            }
                            .frame(width: 34, height: 34)
                    }
                    .contentShape(Rectangle())
            }
            .buttonStyle(AppPressStyle())
            .accessibilityLabel("Increase quantity")

            Spacer()

            QuickChipButton(title: "+1") { tradeViewModel.addQuantity(1) }
            QuickChipButton(title: "+5") { tradeViewModel.addQuantity(5) }
            QuickChipButton(title: "+10") { tradeViewModel.addQuantity(10) }
        }
    }

    private var orderTypeRow: some View {
        HStack(spacing: AppSpacing.md) {
            HudSegmentedControl(
                options: [
                    .init(OrderType.mid, "Mid"),
                    .init(OrderType.market, "Market"),
                ],
                selection: $tradeViewModel.orderType
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

    /// Live `bid × ask` plus indicative mid and estimated notional for the
    /// selected contract (mid × qty × 100, the option multiplier).
    private var quoteLine: String? {
        guard let contract = chainViewModel.selectedContract else { return nil }
        var line = "\(Format.price(contract.bid)) × \(Format.price(contract.ask))"
        if let mid = contract.mid {
            let notional = mid * Double(tradeViewModel.quantity) * 100
            line += " · ≈ \(Format.price(mid)) · Est. \(Format.price(notional))"
        }
        return line
    }

    private var canTrade: Bool {
        chainViewModel.selectedContract != nil
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
        }
        .foregroundStyle(isPlaceholder ? .secondary : .primary)
        .padding(.horizontal, AppSpacing.md)
        .padding(.vertical, 11)
        .frame(maxWidth: fillWidth ? .infinity : nil, minHeight: 44)
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
