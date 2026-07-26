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
/// It stands as tall as the two buttons at the other end of the strip. Nothing
/// about it was ever clipped — the chip measures exactly the 22pt its type and
/// padding ask for, and its centre already sat on the profile glyph's — but a
/// 22pt box between two 36pt-framed buttons reads as cramped, and 11pt Orbitron
/// caps fill 8.3pt of that 22pt. The height goes to internal breathing room;
/// the type is unchanged.
///
/// `minHeight`, not `height`: a hard frame is exactly what *would* sever the
/// glyphs at the top of the Dynamic Type range. The header caps at XXXL, where
/// the line box is still under 36pt, so in practice this is 36pt flat.
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
                .frame(minHeight: ChartHeader.controlHeight)
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
