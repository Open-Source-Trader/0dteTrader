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
///
/// Its border is the diameter of the profile glyph's circle — the ring you see
/// inside that button, `ChartHeader.badgeHeight`, not the 36pt frame the button
/// reserves for touches. It briefly stood at 36 on a misreading of which of the
/// two was meant; at that height it was half the header.
///
/// A hard `height`, unusually, and only because the type is so much shorter than
/// the box: 11pt Orbitron caps fill 8.3pt of it, so there is nothing for a
/// smaller layout box to sever. The header caps Dynamic Type at XXXL, where the
/// caps are still well inside 20pt.
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
                .frame(height: ChartHeader.badgeHeight)
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
                // Drawn at the circle's diameter, targeted at the row's: the
                // two buttons at the other end keep a 36pt frame and so does
                // this, as hit area around the box rather than as the box.
                .frame(height: ChartHeader.controlHeight)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Trading mode \(mode == .live ? "live" : "practice"). Switch mode")
    }
}
