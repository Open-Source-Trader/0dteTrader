import SwiftUI

/// Positions strip (FR-23..25): open positions with unrealized P&L
/// (tap to flatten with confirmation) and open orders with cancel.
struct PositionsStripView: View {
    let positions: [Position]
    let openOrders: [OrderResult]
    let workingSymbols: Set<String>
    let onFlatten: (Position) -> Void
    let onCancelOrder: (OrderResult) -> Void

    @State private var positionPendingFlatten: Position?
    @State private var orderPendingCancel: OrderResult?

    var body: some View {
        VStack(spacing: 6) {
            if !positions.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(positions) { position in
                            positionChip(position)
                        }
                    }
                    .padding(.horizontal, 12)
                }
            }
            if !openOrders.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(openOrders) { order in
                            orderChip(order)
                        }
                    }
                    .padding(.horizontal, 12)
                }
            }
        }
        .alert(
            "Flatten position?",
            isPresented: flattenAlertPresented,
            presenting: positionPendingFlatten
        ) { position in
            Button("Flatten \(abs(position.quantity)) @ Market", role: .destructive) {
                onFlatten(position)
            }
            Button("Cancel", role: .cancel) {}
        } message: { position in
            Text("Submit a market \(position.quantity > 0 ? "sell" : "buy") order to close \(position.symbol)?")
        }
        .alert(
            "Cancel order?",
            isPresented: cancelAlertPresented,
            presenting: orderPendingCancel
        ) { order in
            Button("Cancel Order", role: .destructive) {
                onCancelOrder(order)
            }
            Button("Keep Order", role: .cancel) {}
        } message: { order in
            Text("\(order.side.displayName) \(order.quantity) \(order.contractSymbol)")
        }
    }

    // MARK: - Chips

    private func positionChip(_ position: Position) -> some View {
        Button {
            Haptics.selection()
            positionPendingFlatten = position
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(position.symbol)
                        .font(.chipLabel)
                    if workingSymbols.contains(position.symbol) {
                        ProgressView()
                            .controlSize(.mini)
                    }
                }
                Text("\(Format.signedQuantity(position.quantity)) @ \(Format.price(position.avgPrice))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(Format.signedPrice(position.unrealizedPnl))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(position.unrealizedPnl >= 0 ? Color.pnlPositive : Color.pnlNegative)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(Color.appSurface)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Color.appBorder.opacity(0.5), lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Position \(position.symbol), tap to flatten")
    }

    private func orderChip(_ order: OrderResult) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(order.side.displayName) \(order.quantity) \(order.contractSymbol)")
                    .font(.chipLabel)
                Text("\(order.orderType.displayName) · \(order.status.displayName)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Button {
                Haptics.selection()
                orderPendingCancel = order
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel order")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(Color.appSurface)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.appBorder.opacity(0.5), lineWidth: 0.5)
        )
    }

    // MARK: - Alert bindings

    private var flattenAlertPresented: Binding<Bool> {
        Binding(
            get: { positionPendingFlatten != nil },
            set: { if !$0 { positionPendingFlatten = nil } }
        )
    }

    private var cancelAlertPresented: Binding<Bool> {
        Binding(
            get: { orderPendingCancel != nil },
            set: { if !$0 { orderPendingCancel = nil } }
        )
    }
}
