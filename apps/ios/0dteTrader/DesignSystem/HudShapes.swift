import SwiftUI

/// Chamfered-octagon panel — the HUD card silhouette (angular corner cuts,
/// not rounded). Mirrors the desktop `.hud-card` border-image geometry.
struct HudPanelShape: InsettableShape {
    var chamfer: CGFloat = 10
    var insetAmount: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        let r = rect.insetBy(dx: insetAmount, dy: insetAmount)
        let c = min(chamfer, min(r.width, r.height) / 2)
        var path = Path()
        path.move(to: CGPoint(x: r.minX + c, y: r.minY))
        path.addLine(to: CGPoint(x: r.maxX - c, y: r.minY))
        path.addLine(to: CGPoint(x: r.maxX, y: r.minY + c))
        path.addLine(to: CGPoint(x: r.maxX, y: r.maxY - c))
        path.addLine(to: CGPoint(x: r.maxX - c, y: r.maxY))
        path.addLine(to: CGPoint(x: r.minX + c, y: r.maxY))
        path.addLine(to: CGPoint(x: r.minX, y: r.maxY - c))
        path.addLine(to: CGPoint(x: r.minX, y: r.minY + c))
        path.closeSubpath()
        return path
    }

    func inset(by amount: CGFloat) -> HudPanelShape {
        var shape = self
        shape.insetAmount += amount
        return shape
    }
}

/// Decorative corner tick marks hugging the chamfer edges (the mockups'
/// notched-corner detail). Draw over a `HudPanelShape` stroke.
struct HudCornerTicks: Shape {
    var chamfer: CGFloat = 10
    var overhang: CGFloat = 2.5

    func path(in rect: CGRect) -> Path {
        let t = chamfer + 4
        let a = rect.insetBy(dx: -overhang, dy: -overhang)
        var path = Path()
        path.move(to: CGPoint(x: a.minX + t, y: a.minY))
        path.addLine(to: CGPoint(x: a.minX, y: a.minY + t))
        path.move(to: CGPoint(x: a.maxX - t, y: a.minY))
        path.addLine(to: CGPoint(x: a.maxX, y: a.minY + t))
        path.move(to: CGPoint(x: a.maxX, y: a.maxY - t))
        path.addLine(to: CGPoint(x: a.maxX - t, y: a.maxY))
        path.move(to: CGPoint(x: a.minX, y: a.maxY - t))
        path.addLine(to: CGPoint(x: a.minX + t, y: a.maxY))
        return path
    }
}

/// Chamfered neon card: dark fill, inner top-edge highlight, 1.5px stroke,
/// corner ticks, and an optional outer glow.
///
/// Pass `glow: false` on views that re-render per candle tick (chart pane
/// cards, positions-strip rows) — every glow is an offscreen render pass.
/// Keep simultaneously glowing elements per screen to roughly six.
struct HudCardModifier: ViewModifier {
    var accent: Color = .hudStroke
    var chamfer: CGFloat = 10
    var glow: Bool = true
    var ticks: Bool = true

    func body(content: Content) -> some View {
        content
            .background {
                HudPanelShape(chamfer: chamfer)
                    .fill(Color.hudPanel)
                    .overlay(alignment: .top) {
                        LinearGradient(
                            colors: [Color.hudInnerHighlight, .clear],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                        .frame(height: 18)
                        .clipShape(HudPanelShape(chamfer: chamfer))
                    }
                    .overlay {
                        HudPanelShape(chamfer: chamfer)
                            .strokeBorder(accent, lineWidth: 1.5)
                    }
                    .overlay {
                        if ticks {
                            HudCornerTicks(chamfer: chamfer)
                                .stroke(accent.opacity(0.55), lineWidth: 1.2)
                        }
                    }
                    .compositingGroup()
                    .shadow(color: glow ? accent.opacity(0.5) : .clear, radius: 7)
            }
    }
}

extension View {
    func hudCard(
        accent: Color = .hudStroke,
        chamfer: CGFloat = 10,
        glow: Bool = true,
        ticks: Bool = true
    ) -> some View {
        modifier(HudCardModifier(accent: accent, chamfer: chamfer, glow: glow, ticks: ticks))
    }
}

/// SELL/BUY double-frame button chrome: outer stroked panel with glow, inner
/// inset frame, translucent accent tint, chamfered silhouette.
struct HudActionButtonStyle: ButtonStyle {
    var accent: Color
    var chamfer: CGFloat = 10
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background {
                HudPanelShape(chamfer: chamfer)
                    .fill(Color.hudPanel)
                    .overlay {
                        HudPanelShape(chamfer: chamfer)
                            .fill(accent.opacity(configuration.isPressed ? 0.28 : 0.14))
                    }
                    .overlay {
                        HudPanelShape(chamfer: chamfer)
                            .strokeBorder(accent, lineWidth: 1.5)
                    }
                    .overlay {
                        HudPanelShape(chamfer: max(chamfer - 3, 4))
                            .inset(by: 4)
                            .strokeBorder(accent.opacity(0.7), lineWidth: 1)
                    }
                    .overlay {
                        HudCornerTicks(chamfer: chamfer)
                            .stroke(accent.opacity(0.55), lineWidth: 1.2)
                    }
                    .compositingGroup()
                    .shadow(color: accent.opacity(0.5), radius: 7)
            }
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .animation(reduceMotion ? nil : AppMotion.quick, value: configuration.isPressed)
    }
}
