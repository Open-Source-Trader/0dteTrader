import SwiftUI

/// Floating Buy/Sell buttons overlaid on the fullscreen chart (Layout A, FR-10).
/// Arms the ticket with the current panel configuration (defaults: options,
/// AUTO +1 OTM, nearest expiration, qty 1, mid).
struct FloatingTradeButtons: View {
    let isEnabled: Bool
    let onSide: (OrderSide) -> Void

    var body: some View {
        VStack(spacing: AppSpacing.sm) {
            HStack(spacing: AppSpacing.lg) {
                TradeActionButton(title: "SELL", color: .sellRedFill, isEnabled: isEnabled) {
                    onSide(.sell)
                }
                .shadow(color: AppElevation.toast.color, radius: AppElevation.toast.radius, y: AppElevation.toast.y)
                TradeActionButton(title: "BUY", color: .buyGreenFill, isEnabled: isEnabled) {
                    onSide(.buy)
                }
                .shadow(color: AppElevation.toast.color, radius: AppElevation.toast.radius, y: AppElevation.toast.y)
            }
            .padding(.horizontal, AppSpacing.xl)

            if !isEnabled {
                Text("Select a contract in split view to trade")
                    .font(.chipLabel)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, AppSpacing.md)
                    .padding(.vertical, AppSpacing.xs)
                    .background(Color.appSurface.opacity(0.9))
                    .clipShape(Capsule())
            }
        }
    }
}
