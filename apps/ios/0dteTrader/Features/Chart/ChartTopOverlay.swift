import SwiftUI

/// The quote readout laid over the top-leading corner of the price pane, in
/// place of the header slot it used to occupy — the TradingView arrangement,
/// where the numbers label the candles they belong to instead of sitting in a
/// separate bar above them.
///
/// It never takes touches: the pane below answers a single tap with the
/// placement guide and a triple tap with the fullscreen toggle, and a readout
/// that swallowed either would be a trading control lost to a label.
struct ChartQuoteReadout: View {
    let quote: Quote
    /// Change vs the session open, already computed by the view model.
    let dayChange: (change: Double, percent: Double)?
    /// Ticks into the candle being built; it rode in the header with the price
    /// and follows it here rather than crowding the consolidated top bar.
    let tickProgress: TickProgress?

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: AppSpacing.xs) {
                Text(Format.price(quote.last))
                    .font(.priceMedium.weight(.semibold))
                    .shadow(color: .hudGlow, radius: 6)
                if let dayChange {
                    Text("\(Format.signedPrice(dayChange.change)) (\(String(format: "%+.2f", dayChange.percent))%)")
                        .font(.priceSmall.weight(.medium))
                        .foregroundStyle(dayChange.change >= 0 ? Color.pnlPositive : Color.pnlNegative)
                        .accessibilityLabel(dayChange.change >= 0
                            ? "Up \(Format.price(dayChange.change)) today"
                            : "Down \(Format.price(abs(dayChange.change))) today")
                }
            }
            HStack(spacing: AppSpacing.sm) {
                Text("BID \(Format.price(quote.bid))")
                    .foregroundStyle(Color.buyGreen)
                Text("ASK \(Format.price(quote.ask))")
                    .foregroundStyle(Color.sellRed)
                if let tickProgress {
                    Text("\(tickProgress.count)/\(tickProgress.size) ticks")
                        .foregroundStyle(Color.secondary)
                        .accessibilityLabel(
                            "Building candle: \(tickProgress.count) of \(tickProgress.size) ticks"
                        )
                }
            }
            .font(.caption2.monospacedDigit())
        }
        // Candles run under this corner, so the numbers carry their own
        // backing rather than relying on whatever happens to be behind them.
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Color.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 4))
        .allowsHitTesting(false)
    }
}

/// Options-structure quality chip. It shared the top-leading corner with
/// nothing before the quote readout arrived; now it stacks directly beneath
/// the readout, which is where TradingView keeps indicator legends and the
/// only place that neither collides with the price line nor with the analytics
/// error pinned to the bottom-leading corner.
struct ChartStructChip: View {
    let snapshot: OptionsAnalyticsSnapshotDTO
    let displayState: OptionsAnalyticsDisplayState
    let settings: OptionsAnalyticsSettings
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Text("STRUCT")
                Text(snapshot.quality.status.rawValue.uppercased())
                if displayState == .retained {
                    Text("RETAINED")
                }
                if settings.showDiagnostics && !snapshot.quality.warnings.isEmpty {
                    Image(systemName: "exclamationmark.triangle.fill")
                }
            }
            .font(.system(size: 8, weight: .bold, design: .monospaced))
            .foregroundStyle(
                snapshot.quality.warnings.isEmpty || !settings.showDiagnostics
                    ? Color.appAccent
                    : Color.appWarning
            )
            .padding(.horizontal, 6)
            .frame(minHeight: 28)
            .background(Color.black.opacity(0.72))
            .clipShape(Capsule())
        }
        .accessibilityLabel(
            OptionsAnalyticsPresentation.accessibilitySummary(
                snapshot: snapshot,
                settings: settings
            )
        )
        .accessibilityHint("Shows options structure details")
    }
}
