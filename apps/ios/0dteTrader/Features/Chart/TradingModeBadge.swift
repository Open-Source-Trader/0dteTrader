import SwiftUI

/// Amber PRACTICE / green LIVE chip, parked in the top-trailing corner of the
/// chart surface. Tapping it asks to switch modes (confirmed upstream).
///
/// Two things already own that border, and the badge yields to both. The
/// placement guide's `+` handle sits flush against it at whatever level the
/// guide was summoned to, so the badge gives up the same touch band the order
/// rows do — a badge on the border would shadow the handle at the levels
/// nearest the top edge. And when the options-analytics rail is on it runs the
/// full height of the right edge, so the badge steps inboard of the rail
/// instead of sitting on its readouts.
struct TradingModeBadge: View {
    let mode: TradingMode
    /// Whether the options-analytics rail is drawn on this pane right now.
    let analyticsRailShowing: Bool
    let action: () -> Void

    var body: some View {
        // Only the chip itself takes touches: the reader has no content shape,
        // so a tap anywhere else in the pane still reaches the chart.
        GeometryReader { geometry in
            badge
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                .padding(.trailing, trailingInset(paneWidth: geometry.size.width))
                .padding(.top, AppSpacing.sm)
        }
    }

    /// The rail sizes itself from the chart's *content* rect; the pane width
    /// read here is that plus the axis gutter, so this over-estimates the rail
    /// slightly. Over-estimating is the safe direction — it clears the rail
    /// rather than grazing it.
    private func trailingInset(paneWidth: CGFloat) -> CGFloat {
        guard analyticsRailShowing else { return AppPlacementGuide.handleTouchBand }
        let rail = CGFloat(OptionsAnalyticsPresentation.railWidth(for: Double(paneWidth)))
        return max(AppPlacementGuide.handleTouchBand, rail + AppSpacing.xs)
    }

    private var badge: some View {
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
