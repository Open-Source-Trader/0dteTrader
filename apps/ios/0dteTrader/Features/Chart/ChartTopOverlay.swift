import SwiftUI

/// The quote readout laid over the price pane's first line, centred between the
/// symbol menu and the mode badge — the TradingView arrangement, where the
/// numbers label the candles they belong to instead of sitting in a separate
/// bar above them.
///
/// Last price and percent change only. The bid/ask pair and the absolute change
/// were the width that forced this block into a plate of its own; without them
/// it is short enough to sit on the candles unbacked, which is what keeps the
/// chart reading as one surface. A dark drop shadow does the legibility work a
/// black box used to.
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
        VStack(spacing: 1) {
            HStack(spacing: AppSpacing.xs) {
                Text(Format.price(quote.last))
                    .font(.priceMedium.weight(.semibold))
                    .shadow(color: .hudGlow, radius: 6)
                if let dayChange {
                    Text("(\(String(format: "%+.2f", dayChange.percent))%)")
                        .font(.priceSmall.weight(.medium))
                        .foregroundStyle(dayChange.change >= 0 ? Color.pnlPositive : Color.pnlNegative)
                        // VoiceOver still hears the dollar move: it is the
                        // number a trader acts on, and dropping it from the
                        // display is a density decision, not an editorial one.
                        .accessibilityLabel(dayChange.change >= 0
                            ? "Up \(Format.price(dayChange.change)) today"
                            : "Down \(Format.price(abs(dayChange.change))) today")
                }
            }
            if let tickProgress {
                Text("\(tickProgress.count)/\(tickProgress.size) ticks")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(Color.secondary)
                    .accessibilityLabel(
                        "Building candle: \(tickProgress.count) of \(tickProgress.size) ticks"
                    )
            }
        }
        // Candles run under these numbers now that the plate is gone; a tight
        // black shadow separates them from a wick without printing a box.
        .shadow(color: .black.opacity(0.85), radius: 3)
        .allowsHitTesting(false)
    }
}

/// Symbol menu, moved off the header and onto the pane's top-leading corner so
/// it answers the mode badge at the opposite one. Both sit `AppSpacing.sm` off
/// their two borders; this chip's own chamfer runs parallel to the card's, so
/// at 8pt in from each border it still clears the corner cut by 8.5pt.
struct ChartSymbolButton: View {
    let symbol: String
    let action: () -> Void

    var body: some View {
        Button {
            Haptics.selection()
            action()
        } label: {
            HStack(spacing: AppSpacing.xs) {
                Text(symbol)
                    .font(.hudButton)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Color.appAccent)
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, AppSpacing.sm)
            // Keeps the 36pt target it had in the header. It reads a little
            // taller than the mode badge because of it; a shrunk hit area on
            // the control that changes what you are trading is a worse trade.
            .frame(minHeight: 36)
            .background {
                HudPanelShape(chamfer: 6)
                    // Opaque, for the same reason the mode badge is: it sits
                    // over candles now, not over the header card's fill.
                    .fill(Color.hudPanel)
                    .overlay {
                        HudPanelShape(chamfer: 6)
                            .strokeBorder(Color.hudStroke.opacity(0.6), lineWidth: 1.2)
                    }
            }
            .contentShape(Rectangle())
        }
        .accessibilityLabel("Change symbol")
        .accessibilityValue(symbol)
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
