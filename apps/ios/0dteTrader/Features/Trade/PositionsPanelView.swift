import SwiftUI

/// Swipe-in management drawer over the trade panel (split layout): open
/// positions with Flatten / Trim 50%, working broker orders with Cancel, and
/// working chart-order lines with Cancel and a MID/MKT flip. Presented by
/// `PositionsPanelPresentation`; row content comes pre-formatted from
/// `PositionsPanelRowBuilder` so it stays testable.
struct PositionsPanelView: View {
    @ObservedObject var tradeViewModel: TradeViewModel
    @ObservedObject var chartOrders: ChartOrdersModel
    var tradingLocked: Bool = false
    let onDismiss: () -> Void

    @State private var positionPendingFlatten: Position?
    @State private var positionPendingTrim: Position?
    @State private var orderPendingCancel: OrderResult?
    @State private var chartOrderPendingCancel: ChartOrder?

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: AppSpacing.md) {
                    if rows.isEmpty, workingOrders.isEmpty, workingChartOrders.isEmpty {
                        emptyState
                    } else {
                        if !rows.isEmpty { positionsSection }
                        if !workingOrders.isEmpty { ordersSection }
                        if !workingChartOrders.isEmpty { chartOrdersSection }
                    }
                }
                .padding(AppSpacing.md)
            }
        }
        .background(Color.appSurface)
        .overlay(alignment: .leading) {
            Rectangle().fill(Color.hudStrokeDim).frame(width: 1)
        }
        .alert(
            "Flatten position?",
            isPresented: pendingBinding($positionPendingFlatten),
            presenting: positionPendingFlatten
        ) { position in
            Button("Flatten \(abs(position.quantity)) @ Market", role: .destructive) {
                Task { await tradeViewModel.flatten(position) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { position in
            Text("""
                Submit a market \(position.quantity > 0 ? "sell" : "buy") order to close \
                \(position.symbol)? Realizes \(Format.signedPrice(position.unrealizedPnl)) unrealized P&L.
                """)
        }
        .alert(
            "Trim 50%?",
            isPresented: pendingBinding($positionPendingTrim),
            presenting: positionPendingTrim
        ) { position in
            Button("Trim \(TradeViewModel.trimQuantity(position.quantity)) @ Market", role: .destructive) {
                Task { await tradeViewModel.trimHalf(position) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { position in
            Text("""
                Submits a market order to close \(TradeViewModel.trimQuantity(position.quantity)) \
                of \(abs(position.quantity)) \(position.symbol).
                """)
        }
        .alert(
            "Cancel order?",
            isPresented: pendingBinding($orderPendingCancel),
            presenting: orderPendingCancel
        ) { order in
            Button("Cancel Order", role: .destructive) {
                Task { await tradeViewModel.cancel(order) }
            }
            Button("Keep Order", role: .cancel) {}
        } message: { order in
            Text("\(order.side.displayName) \(order.quantity) \(order.contractSymbol)")
        }
        .alert(
            "Cancel order line?",
            isPresented: pendingBinding($chartOrderPendingCancel),
            presenting: chartOrderPendingCancel
        ) { order in
            Button("Cancel line", role: .destructive) {
                Task { await chartOrders.cancel(id: order.id) }
            }
            Button("Keep", role: .cancel) {}
        } message: { order in
            Text(
                "Removes the \(order.kind.shortLabel) line at \(Format.price(order.triggerPrice)). "
                    + "Nothing was sent to the broker."
            )
        }
    }

    // MARK: - Data

    private var rows: [PositionsPanelPositionRow] {
        PositionsPanelRowBuilder.positionRows(
            positions: tradeViewModel.positions,
            contractResolver: { tradeViewModel.optionContractResolver?($0) }
        )
    }

    private var workingOrders: [OrderResult] {
        tradeViewModel.openOrders
    }

    private var workingChartOrders: [ChartOrder] {
        chartOrders.orders.filter(\.isWorking)
    }

    private func position(for symbol: String) -> Position? {
        tradeViewModel.positions.first { $0.symbol == symbol }
    }

    // MARK: - Chrome

    private var header: some View {
        HStack {
            Text("OPEN & WORKING")
                .font(.chipLabel)
                .kerning(0.5)
                .foregroundStyle(Color.appAccent)
            Spacer()
            Button {
                onDismiss()
            } label: {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.secondary)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(AppPressStyle())
            .accessibilityLabel("Close positions panel")
        }
        .padding(.horizontal, AppSpacing.md)
        .padding(.top, AppSpacing.md)
    }

    private var emptyState: some View {
        Text("Nothing open or working.")
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, AppSpacing.xl)
    }

    private func sectionLabel(_ title: String) -> some View {
        Text(title)
            .font(.chipLabel)
            .foregroundStyle(.secondary)
    }

    private func actionButton(
        _ title: String,
        accent: Color,
        accessibilityLabel: String,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            Haptics.selection()
            action()
        } label: {
            Text(title)
                .font(.chipLabel)
                .foregroundStyle(accent)
                .frame(maxWidth: .infinity, minHeight: 32)
        }
        .buttonStyle(HudActionButtonStyle(accent: accent.opacity(0.6), chamfer: 6))
        .accessibilityLabel(accessibilityLabel)
    }

    private func rowChrome(_ content: some View) -> some View {
        content
            .padding(AppSpacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.appBackground, in: HudPanelShape(chamfer: 6))
            .overlay(
                HudPanelShape(chamfer: 6)
                    .strokeBorder(Color.hudStrokeDim.opacity(0.5), lineWidth: 1)
            )
    }

    // MARK: - Positions

    private var positionsSection: some View {
        VStack(alignment: .leading, spacing: AppSpacing.sm) {
            sectionLabel("POSITIONS")
            ForEach(rows) { row in
                rowChrome(positionRow(row))
            }
        }
    }

    private func positionRow(_ row: PositionsPanelPositionRow) -> some View {
        let isWorking = tradeViewModel.workingSymbols.contains(row.id)
        return VStack(alignment: .leading, spacing: AppSpacing.xs) {
            HStack {
                Text("\(row.label) · \(row.quantity)")
                    .font(.system(.footnote, design: .monospaced).weight(.semibold))
                    .foregroundStyle(Color.secondary)
                    .lineLimit(1)
                Spacer()
                Text(row.pnl)
                    .font(.priceSmall.weight(.semibold))
                    .foregroundStyle(row.pnlIsPositive ? Color.pnlPositive : Color.pnlNegative)
                    .contentTransition(.numericText())
            }
            Text("Entry \(row.entry) · Mark \(row.mark)")
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(spacing: AppSpacing.sm) {
                actionButton(
                    "Flatten",
                    accent: .sellRed,
                    accessibilityLabel: "Flatten \(row.label)"
                ) {
                    positionPendingFlatten = position(for: row.id)
                }
                if row.canTrim {
                    actionButton(
                        "Trim 50%",
                        accent: .appWarning,
                        accessibilityLabel: "Trim half of \(row.label)"
                    ) {
                        positionPendingTrim = position(for: row.id)
                    }
                }
            }
            .disabled(tradingLocked || isWorking)
            .opacity(tradingLocked || isWorking ? 0.55 : 1)
        }
        .accessibilityElement(children: .contain)
    }

    // MARK: - Working broker orders

    private var ordersSection: some View {
        VStack(alignment: .leading, spacing: AppSpacing.sm) {
            sectionLabel("WORKING ORDERS")
            ForEach(workingOrders) { order in
                rowChrome(orderRow(order))
            }
        }
    }

    private func orderRow(_ order: OrderResult) -> some View {
        HStack(spacing: AppSpacing.sm) {
            VStack(alignment: .leading, spacing: AppSpacing.xxs) {
                Text("\(order.side.displayName) \(order.quantity) \(order.contractSymbol)")
                    .font(.chipLabel)
                    .foregroundStyle(order.side == .buy ? Color.buyGreen : Color.sellRed)
                    .lineLimit(1)
                Text("\(order.orderType.displayName) · \(order.status.displayName)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            Spacer()
            Button {
                Haptics.selection()
                orderPendingCancel = order
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(AppPressStyle())
            .disabled(tradingLocked)
            .opacity(tradingLocked ? 0.55 : 1)
            .accessibilityLabel("Cancel \(order.side.displayName) order, \(order.quantity) \(order.contractSymbol)")
        }
    }

    // MARK: - Working chart-order lines

    private var chartOrdersSection: some View {
        VStack(alignment: .leading, spacing: AppSpacing.sm) {
            sectionLabel("CHART ORDER LINES")
            ForEach(workingChartOrders) { order in
                rowChrome(chartOrderRow(order))
            }
        }
    }

    private func chartOrderRow(_ order: ChartOrder) -> some View {
        HStack(spacing: AppSpacing.sm) {
            VStack(alignment: .leading, spacing: AppSpacing.xxs) {
                Text("\(order.kind.shortLabel) \(order.side.displayName) \(order.quantity) @ \(Format.price(order.triggerPrice))")
                    .font(.chipLabel)
                    .foregroundStyle(Color.secondary)
                    .lineLimit(1)
                Text(order.contractSymbol)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .accessibilityElement(children: .combine)
            Spacer()
            Button {
                Task { await chartOrders.toggleOrderType(id: order.id) }
            } label: {
                Text(order.orderTypeLabel)
                    .font(.chipLabel)
                    .foregroundStyle(Color.appAccent)
                    .frame(minWidth: 40, minHeight: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(HudActionButtonStyle(accent: .hudStrokeDim, chamfer: 6))
            .disabled(tradingLocked)
            .accessibilityLabel(
                "Execution \(order.orderTypeLabel). Double-tap to switch to "
                    + (order.orderType == .mid ? "market" : "mid")
            )
            Button {
                Haptics.selection()
                chartOrderPendingCancel = order
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(AppPressStyle())
            .disabled(tradingLocked)
            .opacity(tradingLocked ? 0.55 : 1)
            .accessibilityLabel("Cancel \(order.kind.shortLabel) line at \(Format.price(order.triggerPrice))")
        }
    }

    // MARK: - Alert bindings

    private func pendingBinding<Value>(_ value: Binding<Value?>) -> Binding<Bool> {
        Binding(
            get: { value.wrappedValue != nil },
            set: { if !$0 { value.wrappedValue = nil } }
        )
    }
}
