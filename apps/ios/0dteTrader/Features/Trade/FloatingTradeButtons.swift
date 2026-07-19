import SwiftUI

/// Floating Buy/Sell buttons overlaid on the fullscreen chart (Layout A, FR-10).
/// Arms the ticket with the current panel configuration (defaults: options,
/// AUTO +1 OTM, nearest expiration, qty 1, mid).
struct FloatingTradeButtons: View {
    let isEnabled: Bool
    let onSide: (OrderSide) -> Void

    var body: some View {
        VStack(spacing: AppSpacing.sm) {
            // Glow is baked into the buttons' HUD frames — no extra shadows.
            HStack(spacing: AppSpacing.lg) {
                TradeActionButton(title: "SELL", color: .sellRed, isEnabled: isEnabled) {
                    onSide(.sell)
                }
                TradeActionButton(title: "BUY", color: .buyGreen, isEnabled: isEnabled) {
                    onSide(.buy)
                }
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
