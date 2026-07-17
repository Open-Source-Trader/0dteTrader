import SwiftUI

/// Floating Buy/Sell buttons overlaid on the fullscreen chart (Layout A, FR-10).
/// Arms the ticket with the current panel configuration (defaults: options,
/// AUTO +1 OTM, nearest expiration, qty 1, mid).
struct FloatingTradeButtons: View {
    let isEnabled: Bool
    let onSide: (OrderSide) -> Void

    var body: some View {
        HStack(spacing: 16) {
            TradeActionButton(title: "SELL", color: .sellRed, isEnabled: isEnabled) {
                onSide(.sell)
            }
            TradeActionButton(title: "BUY", color: .buyGreen, isEnabled: isEnabled) {
                onSide(.buy)
            }
        }
        .padding(.horizontal, 20)
    }
}
