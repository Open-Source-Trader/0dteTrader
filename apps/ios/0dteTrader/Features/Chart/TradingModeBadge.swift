import SwiftUI

/// Amber PRACTICE / green LIVE chip, hugging the top-trailing corner of the
/// header strip. Tapping it asks to switch modes (confirmed upstream).
///
/// It sat on the chart's own top-trailing border, at this same 8pt inset, until
/// the indicator and drawing-tool chips wanted that corner. Which mode you are
/// trading in is a fact about the account rather than about the chart, so the
/// header is where it belongs anyway — and off the pane it stops shadowing the
/// two things that share the chart's right border: the placement guide's `+`,
/// which can be summoned to any level including the ones nearest the top edge,
/// and the options-analytics rail's topmost readout.
///
/// PRACTICE is the longer word, so the chip is laid out trailing-aligned: both
/// labels end on the same pixel.
struct TradingModeBadge: View {
    let mode: TradingMode
    let action: () -> Void

    var body: some View {
        Button {
            Haptics.selection()
            action()
        } label: {
            Text(mode == .live ? "LIVE" : "PRACTICE")
                .font(.custom("Orbitron-Bold", size: 11, relativeTo: .caption2))
                .kerning(1)
                .foregroundStyle(mode == .live ? Color.buyGreen : Color.hudAmber)
                .padding(.horizontal, AppSpacing.sm)
                .padding(.vertical, AppSpacing.xs)
                .background {
                    HudPanelShape(chamfer: 5)
                        // Opaque behind the chip, the way it was over candles:
                        // the header strip has no card of its own to sit on.
                        .fill(Color.hudPanel)
                        .overlay {
                            HudPanelShape(chamfer: 5)
                                .strokeBorder(
                                    mode == .live ? Color.buyGreen : Color.hudAmber,
                                    lineWidth: 1
                                )
                        }
                }
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Trading mode \(mode == .live ? "live" : "practice"). Switch mode")
    }
}
