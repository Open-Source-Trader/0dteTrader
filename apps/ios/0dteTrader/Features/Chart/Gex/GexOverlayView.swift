import DGCharts
import UIKit

/// Read-only CoreGraphics overlay for the GEX/DEX level structure (GexOverlay.tsx
/// analog): premium heat bands, regime zone shading between the walls, labeled
/// level lines, and a GEX/DEX regime readout. Sits between the TWC overlay and
/// the interactive DrawingOverlayView; no pointer interaction.
final class GexOverlayView: UIView {
    weak var chart: CombinedChartView?
    var model: GexLevels? {
        didSet { if model != oldValue { setNeedsDisplay() } }
    }
    var settings: GexSettings = .default {
        didSet { if settings != oldValue { setNeedsDisplay() } }
    }
    var stale: Bool = false {
        didSet { if stale != oldValue { setNeedsDisplay() } }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isUserInteractionEnabled = false
        contentMode = .redraw
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func yPixel(for price: Double) -> CGFloat? {
        guard let chart else { return nil }
        // Levels are horizontal: any x inside the plotted range works; use 0
        // like the drawing overlay's horizontal lines.
        let point = chart.getTransformer(forAxis: .left).pixelForValues(x: 0, y: price)
        guard point.y.isFinite else { return nil }
        return point.y
    }

    private func drawLine(
        in context: CGContext,
        rect: CGRect,
        price: Double,
        color: UIColor,
        label: String,
        dashed: Bool = false
    ) {
        guard let y = yPixel(for: price) else { return }
        context.setStrokeColor(color.cgColor)
        context.setLineWidth(1.5)
        context.setLineDash(phase: 0, lengths: dashed ? [6, 4] : [])
        context.move(to: CGPoint(x: rect.minX, y: y))
        context.addLine(to: CGPoint(x: rect.maxX, y: y))
        context.strokePath()
        context.setLineDash(phase: 0, lengths: [])

        let text = label as NSString
        let attributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.systemFont(ofSize: 10, weight: .medium),
            .foregroundColor: UIColor.black,
        ]
        let size = text.size(withAttributes: attributes)
        let pill = CGRect(
            x: rect.maxX - size.width - 18,
            y: y - 8,
            width: size.width + 12,
            height: 16
        )
        context.setFillColor(color.withAlphaComponent(0.9).cgColor)
        context.fill(pill)
        text.draw(at: CGPoint(x: pill.minX + 6, y: y - size.height / 2), withAttributes: attributes)
    }

    override func draw(_ rect: CGRect) {
        guard let model, let chart,
              let context = UIGraphicsGetCurrentContext()
        else { return }

        let content = chart.viewPortHandler.contentRect
        context.clip(to: content)

        // ── Premium heat bands (below the level lines, drawn first) ──
        if settings.showPremium, !model.topPremium.isEmpty {
            let shown = Array(model.topPremium.prefix(settings.maxPremiumStrikes))
            let maxPremium = shown.map(\.totalPremium).max() ?? 0
            let half = GexPresentation.bandHalfHeight(
                strikes: shown.map(\.strike),
                spot: model.spot
            )
            for (index, level) in shown.enumerated() {
                guard let yTop = yPixel(for: level.strike + half),
                      let yBottom = yPixel(for: level.strike - half)
                else { continue }
                let intensity = maxPremium > 0 ? level.totalPremium / maxPremium : 0
                let alpha = GexPresentation.bandAlpha(
                    intensity: intensity,
                    cap: settings.opacityCap
                )
                context.setFillColor(GexPresentation.premiumColor.withAlphaComponent(alpha).cgColor)
                context.fill(CGRect(x: content.minX, y: yTop, width: content.width, height: yBottom - yTop))
                // Only the top 3 get text; the rest stay quiet bands.
                if index < 3 {
                    let notional = GexPresentation.dollarText(level.totalPremium)
                    let label = "$\(Format.strike(level.strike)) — \(notional.dropFirst()) premium" as NSString
                    let attributes: [NSAttributedString.Key: Any] = [
                        .font: UIFont.systemFont(ofSize: 9, weight: .medium),
                        .foregroundColor: GexPresentation.premiumColor.withAlphaComponent(0.95),
                    ]
                    label.draw(at: CGPoint(x: content.minX + 6, y: yTop + 2), withAttributes: attributes)
                }
            }
        }

        if settings.showLevels {
            // ── Regime zone between put wall and call wall ──
            if let putWall = model.putWall, let callWall = model.callWall {
                let low = min(putWall, callWall)
                let high = max(putWall, callWall)
                if let yTop = yPixel(for: high), let yBottom = yPixel(for: low) {
                    let zoneColor = model.netGex >= 0
                        ? GexPresentation.callWallColor
                        : GexPresentation.putWallColor
                    context.setFillColor(zoneColor.withAlphaComponent(0.07).cgColor)
                    context.fill(CGRect(x: content.minX, y: yTop, width: content.width, height: yBottom - yTop))
                }
            }

            // ── Level lines ──
            if let putWall = model.putWall {
                drawLine(in: context, rect: content, price: putWall,
                         color: GexPresentation.putWallColor,
                         label: "Put Wall $" + Format.strike(putWall))
            }
            if let callWall = model.callWall {
                drawLine(in: context, rect: content, price: callWall,
                         color: GexPresentation.callWallColor,
                         label: "Call Wall $" + Format.strike(callWall))
            }
            if let gammaFlip = model.gammaFlip {
                drawLine(in: context, rect: content, price: gammaFlip,
                         color: GexPresentation.gammaFlipColor,
                         label: "Gamma Flip $" + Format.price(gammaFlip, fractionDigits: 1),
                         dashed: true)
            }
            if let magnet = model.magnet {
                drawLine(in: context, rect: content, price: magnet,
                         color: GexPresentation.magnetColor,
                         label: (model.isZeroDte ? "0DTE Magnet $" : "Magnet $") + Format.strike(magnet),
                         dashed: true)
            }
        }

        // ── Regime readout, top-right ──
        let regime = model.netGex >= 0 ? "positive" : "negative"
        let gexText = "GEX: \(GexPresentation.dollarText(model.netGex)) (\(regime))\(stale ? " · STALE" : "")" as NSString
        let dexText = "DEX: \(GexPresentation.dollarText(model.netDex))" as NSString
        let readoutFont = UIFont.monospacedDigitSystemFont(ofSize: 10, weight: .regular)
        let attributes: [NSAttributedString.Key: Any] = [.font: readoutFont]
        let gexSize = gexText.size(withAttributes: attributes)
        let dexSize = dexText.size(withAttributes: attributes)
        let boxWidth = max(gexSize.width, dexSize.width) + 16
        let box = CGRect(x: content.maxX - boxWidth - 6, y: content.minY + 6, width: boxWidth, height: 34)
        context.setFillColor(UIColor(red: 0.031, green: 0.063, blue: 0.125, alpha: 0.82).cgColor)
        context.fill(box)
        let gexColor = stale
            ? GexPresentation.premiumColor
            : (model.netGex >= 0 ? GexPresentation.callWallColor : GexPresentation.putWallColor)
        gexText.draw(
            at: CGPoint(x: box.minX + 8, y: box.minY + 3),
            withAttributes: [.font: readoutFont, .foregroundColor: gexColor]
        )
        dexText.draw(
            at: CGPoint(x: box.minX + 8, y: box.minY + 17),
            withAttributes: [.font: readoutFont, .foregroundColor: UIColor.white.withAlphaComponent(0.6)]
        )
    }
}
