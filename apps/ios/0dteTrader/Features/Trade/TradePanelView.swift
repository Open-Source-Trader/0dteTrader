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

    var body: some View {
        VStack(spacing: 8) {
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

            HStack(spacing: 12) {
                TradeActionButton(title: "SELL", color: .sellRed, isEnabled: canTrade) {
                    onArm(.sell)
                }
                TradeActionButton(title: "BUY", color: .buyGreen, isEnabled: canTrade) {
                    onArm(.buy)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
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
        VStack(spacing: 8) {
            HStack(spacing: 8) {
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

            HStack(spacing: 8) {
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
                systemImage: "calendar"
            )
        }
    }

    private func expirationLabel(_ expiration: String) -> String {
        if expiration == DateParsing.dayString(from: Date()) {
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
                systemImage: "chart.line.uptrend.xyaxis"
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
                    .font(.caption)
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
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    // MARK: - Futures

    private var futuresSection: some View {
        HStack(spacing: 8) {
            Menu {
                ForEach(FuturesRoots.known, id: \.self) { root in
                    Button(root) {
                        Task { await tradeViewModel.setFuturesRoot(root) }
                    }
                }
            } label: {
                chipLabel(title: tradeViewModel.futuresRoot, systemImage: "shippingbox")
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
                    systemImage: "doc.text"
                )
            }

            if let future = tradeViewModel.selectedFuture {
                Text(future.mid.map { "≈ \(Format.price($0))" } ?? "—")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Quantity & order type

    private var quantityRow: some View {
        HStack(spacing: 10) {
            Text("Qty")
                .font(.panelLabel)
                .foregroundStyle(.secondary)

            Button {
                tradeViewModel.addQuantity(-1)
            } label: {
                Image(systemName: "minus")
                    .frame(width: 30, height: 30)
                    .background(Color.appSurfaceElevated)
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)

            Text("\(tradeViewModel.quantity)")
                .font(.priceMedium)
                .frame(minWidth: 36)

            Button {
                tradeViewModel.addQuantity(1)
            } label: {
                Image(systemName: "plus")
                    .frame(width: 30, height: 30)
                    .background(Color.appSurfaceElevated)
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)

            Spacer()

            QuickChipButton(title: "+1") { tradeViewModel.addQuantity(1) }
            QuickChipButton(title: "+5") { tradeViewModel.addQuantity(5) }
            QuickChipButton(title: "+10") { tradeViewModel.addQuantity(10) }
        }
    }

    private var orderTypeRow: some View {
        HStack(spacing: 10) {
            Picker("Order type", selection: $tradeViewModel.orderType) {
                Text("Mid").tag(OrderType.mid)
                Text("Market").tag(OrderType.market)
            }
            .pickerStyle(.segmented)

            if let line = quoteLine {
                Text(line)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// Live `bid × ask` (and mid when a mid order is armed) for the selected contract.
    private var quoteLine: String? {
        guard let pair = selectedQuotePair else { return nil }
        var line = "\(Format.price(pair.bid)) × \(Format.price(pair.ask))"
        if tradeViewModel.orderType == .mid {
            line += " · ≈ \(indicativeMid.map(Format.price) ?? "—")"
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

    private func chipLabel(title: String, systemImage: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage)
                .font(.caption)
            Text(title)
                .font(.chipLabel)
                .lineLimit(1)
        }
        .foregroundStyle(.primary)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity)
        .background(Color.appSurfaceElevated)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}
