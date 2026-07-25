import SwiftUI

/// Positions strip (FR-23..25): open positions with unrealized P&L
/// (tap to flatten with confirmation) and open orders with cancel.
struct PositionsStripView: View {
    let positions: [Position]
    let openOrders: [OrderResult]
    let workingSymbols: Set<String>
    /// When true, flatten and cancel are disabled (trading lock active).
    var tradingLocked: Bool = false
    let onFlatten: (Position) -> Void
    let onCancelOrder: (OrderResult) -> Void

    @State private var positionPendingFlatten: Position?
    @State private var orderPendingCancel: OrderResult?

    var body: some View {
        VStack(spacing: AppSpacing.sm) {
            if !positions.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: AppSpacing.sm) {
                        ForEach(positions) { position in
                            positionChip(position)
                        }
                    }
                    .padding(.horizontal, AppSpacing.md)
                }
                .mask(scrollFadeMask)
            }
            if !openOrders.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: AppSpacing.sm) {
                        ForEach(openOrders) { order in
                            orderChip(order)
                        }
                    }
                    .padding(.horizontal, AppSpacing.md)
                }
                .mask(scrollFadeMask)
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
            Text("""
                Submit a market \(position.quantity > 0 ? "sell" : "buy") order to close \
                \(position.symbol)? Realizes \(Format.signedPrice(position.unrealizedPnl)) unrealized P&L.
                """)
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

    /// Trailing-edge fade so clipped chips hint that more content exists.
    private var scrollFadeMask: some View {
        HStack(spacing: 0) {
            Color.black
            LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
                .frame(width: AppSpacing.xxl)
        }
    }

    // MARK: - Chips

    private func positionChip(_ position: Position) -> some View {
        let isWorking = workingSymbols.contains(position.symbol)
        return Button {
            Haptics.selection()
            positionPendingFlatten = position
        } label: {
            VStack(alignment: .leading, spacing: AppSpacing.xxs) {
                HStack(spacing: 6) {
                    Text(position.symbol)
                        .font(.chipLabel)
                    if isWorking {
                        ProgressView()
                            .controlSize(.mini)
                            .accessibilityLabel("Order working")
                    }
                }
                Text("\(Format.signedQuantity(position.quantity)) @ \(Format.price(position.avgPrice))")
                    .font(.priceSmall)
                    .foregroundStyle(.secondary)
                Text(Format.signedPrice(position.unrealizedPnl))
                    .font(.priceSmall.weight(.semibold))
                    .foregroundStyle(position.unrealizedPnl >= 0 ? Color.pnlPositive : Color.pnlNegative)
                    .contentTransition(.numericText())
                    .animation(.easeInOut(duration: 0.2), value: position.unrealizedPnl)
            }
            .padding(.horizontal, AppSpacing.md)
            .padding(.vertical, AppSpacing.sm)
            .background(Color.appSurface)
            .clipShape(RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous)
                    .stroke(Color.appBorder, lineWidth: 1)
            )
            .opacity(isWorking || tradingLocked ? 0.6 : 1)
        }
        .buttonStyle(AppPressStyle())
        .disabled(isWorking || tradingLocked)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("""
            Position \(position.symbol), quantity \(position.quantity), average price \
            \(Format.price(position.avgPrice)), unrealized P&L \(Format.signedPrice(position.unrealizedPnl)) dollars
            """)
        .accessibilityHint("Double-tap to flatten at market")
    }

    private func orderChip(_ order: OrderResult) -> some View {
        HStack(spacing: AppSpacing.sm) {
            VStack(alignment: .leading, spacing: AppSpacing.xxs) {
                Text("\(order.side.displayName) \(order.quantity) \(order.contractSymbol)")
                    .font(.chipLabel)
                    .foregroundStyle(order.side == .buy ? Color.buyGreen : Color.sellRed)
                Text("\(order.orderType.displayName) · \(order.status.displayName)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            Button {
                Haptics.selection()
                orderPendingCancel = order
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
                    .opacity(tradingLocked ? 0.55 : 1)
            }
            .buttonStyle(AppPressStyle())
            .disabled(tradingLocked)
            .accessibilityLabel("Cancel \(order.side.displayName) order, \(order.quantity) \(order.contractSymbol)")
        }
        .padding(.leading, AppSpacing.md)
        .padding(.trailing, AppSpacing.xxs)
        .padding(.vertical, AppSpacing.sm)
        .background(Color.appSurface)
        .clipShape(RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous)
                .stroke(Color.appBorder, lineWidth: 1)
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
