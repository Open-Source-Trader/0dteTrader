import SwiftUI

/// Amber PRACTICE / green LIVE chip, hugging the top-trailing corner of the
/// chart surface. Tapping it asks to switch modes (confirmed upstream).
///
/// It used to step inboard of the placement guide's `+` handle band and of the
/// options-analytics rail. Both are real overlaps, and both were traded away
/// deliberately: parked ~130pt off the border the chip read as floating in the
/// middle of the pane rather than labelling it. What it costs is the top of the
/// right border — a guide summoned to a level within a chip's height of the top
/// edge puts its handle under this chip, and the rail's topmost readout can run
/// behind it. Both are recoverable by scrolling the price axis; a badge that
/// looked misplaced was not.
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
                        // Opaque behind the chip: it now sits over candles, not
                        // over the header card's fill.
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
