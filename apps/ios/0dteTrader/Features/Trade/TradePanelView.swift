import SwiftUI

/// Layout B's bottom trade panel (FR-13..18): asset class, contract selection
/// (expiration / strike / AUTO for options, root / contract for futures),
/// quantity quick-steppers, mid/market toggle, and Buy/Sell arm buttons.
struct TradePanelView: View {
    @ObservedObject var tradeViewModel: TradeViewModel
    @ObservedObject var chainViewModel: OptionsChainViewModel
    let underlying: String
    let positionsStrip: PositionsStripView
    let onArm: (OrderSide) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ScrollView(.vertical) {
            VStack(spacing: AppSpacing.sm) {
                positionsStrip

                Picker("Asset class", selection: $tradeViewModel.assetClass) {
                    Text("Options").tag(AssetClass.option)
                    Text("Futures").tag(AssetClass.future)
                }
                .pickerStyle(.segmented)

                if tradeViewModel.assetClass == .option {
                    optionsSection
                } else {
                    futuresSection
                }

                quantityRow
                orderTypeRow

                HStack(spacing: AppSpacing.md) {
                    TradeActionButton(title: "SELL", color: .sellRedFill, isEnabled: canTrade) {
                        onArm(.sell)
                    }
                    TradeActionButton(title: "BUY", color: .buyGreenFill, isEnabled: canTrade) {
                        onArm(.buy)
                    }
                }
            }
            .padding(.horizontal, AppSpacing.md)
            .padding(.top, AppSpacing.xs)
            .padding(.bottom, AppSpacing.sm)
            .frame(maxWidth: .infinity)
            .animation(reduceMotion ? nil : .snappy(duration: 0.22, extraBounce: 0), value: tradeViewModel.assetClass)
            .animation(reduceMotion ? nil : .snappy(duration: 0.22, extraBounce: 0), value: chainViewModel.isAutoMode)
        }
        .scrollIndicators(.hidden)
        .scrollBounceBehavior(.basedOnSize)
        .background(Color.appBackground)
        .task {
            // Ensure a contract list exists even when the chart symbol isn't
            // a futures root (setFuturesRoot skips no-op reloads).
            if tradeViewModel.futuresContracts.isEmpty {
                await tradeViewModel.loadFuturesContracts()
            }
        }
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
                Picker("Option type", selection: $chainViewModel.optionType) {
                    Text("Call").tag(OptionType.call)
                    Text("Put").tag(OptionType.put)
                }
                .pickerStyle(.segmented)

                Toggle(isOn: $chainViewModel.isAutoMode) {
                    Text("AUTO")
                        .font(.chipLabel)
                }
                .toggleStyle(.button)
                .tint(.appAccent)
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
        .background(Color.appSurface)
        .clipShape(RoundedRectangle(cornerRadius: AppRadius.sm, style: .continuous))
    }

    // MARK: - Futures

    private var futuresSection: some View {
        VStack(spacing: AppSpacing.sm) {
            if let message = tradeViewModel.futuresError {
                errorRow(message) {
                    Task { await tradeViewModel.loadFuturesContracts() }
                }
            }

            HStack(spacing: AppSpacing.sm) {
                Menu {
                    ForEach(FuturesRoots.known, id: \.self) { root in
                        Button(root) {
                            Task { await tradeViewModel.setFuturesRoot(root) }
                        }
                    }
                } label: {
                    chipLabel(title: tradeViewModel.futuresRoot, systemImage: "shippingbox", fillWidth: false)
                }

                Menu {
                    ForEach(tradeViewModel.futuresContracts) { contract in
                        Button {
                            tradeViewModel.selectedFutureSymbol = contract.symbol
                        } label: {
                            HStack {
                                Text(contract.symbol)
                                if contract.frontMonth {
                                    Text("· front")
                                        .foregroundStyle(.secondary)
                                }
                                if contract.symbol == tradeViewModel.selectedFutureSymbol {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                } label: {
                    chipLabel(
                        title: tradeViewModel.selectedFutureSymbol ?? "Contract",
                        systemImage: "doc.text",
                        isPlaceholder: tradeViewModel.selectedFutureSymbol == nil,
                        fillWidth: false
                    )
                }

                Spacer(minLength: 0)
            }

            // Second row matches autoContractLabel's height so switching asset
            // class doesn't reflow the ticket.
            HStack {
                if let future = tradeViewModel.selectedFuture {
                    Text(future.mid.map { "≈ \(Format.price($0))" } ?? "—")
                        .font(.priceSmall)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else {
                    Text("No contract")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 34)
            .padding(.horizontal, 10)
            .background(Color.appSurface)
            .clipShape(RoundedRectangle(cornerRadius: AppRadius.sm, style: .continuous))
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
                    .background(Circle().fill(Color.appSurfaceElevated).frame(width: 32, height: 32))
                    .contentShape(Rectangle())
            }
            .buttonStyle(AppPressStyle())
            .accessibilityLabel("Decrease quantity")

            Text("\(tradeViewModel.quantity)")
                .font(.priceMedium)
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
                    .background(Circle().fill(Color.appSurfaceElevated).frame(width: 32, height: 32))
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
            Picker("Order type", selection: $tradeViewModel.orderType) {
                Text("Mid").tag(OrderType.mid)
                Text("Market").tag(OrderType.market)
            }
            .pickerStyle(.segmented)

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
    /// selected contract (mid × qty × contract multiplier — options: 100).
    private var quoteLine: String? {
        guard let pair = selectedQuotePair else { return nil }
        var line = "\(Format.price(pair.bid)) × \(Format.price(pair.ask))"
        if let mid = indicativeMid {
            let multiplier: Double = tradeViewModel.assetClass == .option ? 100 : 1
            let notional = mid * Double(tradeViewModel.quantity) * multiplier
            line += " · ≈ \(Format.price(mid)) · Est. \(Format.price(notional))"
        }
        return line
    }

    private var selectedQuotePair: (bid: Double, ask: Double)? {
        switch tradeViewModel.assetClass {
        case .option:
            return chainViewModel.selectedContract.map { ($0.bid, $0.ask) }
        case .future:
            return tradeViewModel.selectedFuture.map { ($0.bid, $0.ask) }
        }
    }

    /// Indicative mid for the currently selected contract (server recomputes at send).
    private var indicativeMid: Double? {
        switch tradeViewModel.assetClass {
        case .option:
            return chainViewModel.selectedContract?.mid
        case .future:
            return tradeViewModel.selectedFuture?.mid
        }
    }

    private var canTrade: Bool {
        switch tradeViewModel.assetClass {
        case .option:
            return chainViewModel.selectedContract != nil
        case .future:
            return tradeViewModel.selectedFuture != nil
        }
    }

    // MARK: - Shared chrome

    /// Inline load-error row with a retry action (chain / futures failures).
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
        .background(Color.appSurface)
        .clipShape(RoundedRectangle(cornerRadius: AppRadius.sm, style: .continuous))
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
        .background(Color.appSurfaceElevated)
        .clipShape(RoundedRectangle(cornerRadius: AppRadius.sm, style: .continuous))
    }
}
