import DGCharts
import UIKit

/// Current-snapshot structure overlay. Price levels (walls, breakevens,
/// ranges) span the full chart width like standard charting level lines;
/// the strike profile bars stay anchored to the chart's right edge.
final class OptionsAnalyticsOverlayView: UIView {
    private struct RailLine {
        let price: Double
        let label: String
        let color: UIColor
        let dashed: Bool
    }

    weak var chart: CombinedChartView?
    var snapshot: OptionsAnalyticsSnapshotDTO? {
        didSet { refresh() }
    }
    var settings: OptionsAnalyticsSettings = .default {
        didSet { refresh() }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isUserInteractionEnabled = false
        contentMode = .redraw
        isAccessibilityElement = false
        accessibilityTraits = .updatesFrequently
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func refresh() {
        isAccessibilityElement = settings.enabled && snapshot != nil
        accessibilityLabel = snapshot.map {
            OptionsAnalyticsPresentation.accessibilitySummary(snapshot: $0, settings: settings)
        }
        accessibilityValue = nil
        setNeedsDisplay()
    }

    private func yPixel(for price: Double, in content: CGRect) -> CGFloat? {
        guard let chart else { return nil }
        let point = chart.getTransformer(forAxis: .left).pixelForValues(x: 0, y: price)
        guard point.y.isFinite, content.minY...content.maxY ~= point.y else { return nil }
        return point.y
    }

    override func draw(_ rect: CGRect) {
        guard let chart,
              let snapshot,
              let context = UIGraphicsGetCurrentContext()
        else { return }
        let content = chart.viewPortHandler.contentRect
        context.saveGState()
        context.clip(to: content)
        let railWidth = OptionsAnalyticsPresentation.railWidth(for: content.width)
        let rail = CGRect(
            x: content.maxX - railWidth,
            y: content.minY,
            width: railWidth,
            height: content.height
        )

        drawRanges(snapshot: snapshot, rail: rail, content: content, in: context)
        drawWalls(snapshot: snapshot, rail: rail, content: content, in: context)
        if settings.showGammaProfile || settings.showMarkedOi || settings.showLiquidity {
            drawProfile(snapshot: snapshot, rail: rail, content: content, in: context)
        }
        if settings.showDealerProxy {
            drawProxyRoots(snapshot: snapshot, rail: rail, content: content, in: context)
        }
        drawRailKey(rail: rail, in: context)
        context.restoreGState()
    }

    private func drawProfile(
        snapshot: OptionsAnalyticsSnapshotDTO,
        rail: CGRect,
        content: CGRect,
        in context: CGContext
    ) {
        let strikes = OptionsAnalyticsPresentation.selectedProfileStrikes(
            strikes: snapshot.strikes,
            spot: snapshot.scope.spot,
            settings: settings,
            isVisible: { self.yPixel(for: $0.strike, in: content) != nil }
        )
        let normalization = OptionsAnalyticsPresentation.profileNormalization(for: snapshot.strikes)
        let centerX = rail.midX
        let maximumWidth = rail.width * 0.43

        for strike in strikes {
            guard let y = yPixel(for: strike.strike, in: content) else { continue }
            let callWidth = maximumWidth * OptionsAnalyticsPresentation.magnitudeFraction(
                value: strike.call?.gammaExposure ?? 0,
                maximum: normalization.gammaExposure
            )
            let putWidth = maximumWidth * OptionsAnalyticsPresentation.magnitudeFraction(
                value: strike.put?.gammaExposure ?? 0,
                maximum: normalization.gammaExposure
            )
            if settings.showGammaProfile, normalization.gammaExposure > 0 {
                context.setFillColor(
                    OptionsAnalyticsPresentation.putColor
                        .withAlphaComponent(liquidityAlpha(strike.put?.relativeSpread))
                        .cgColor
                )
                context.fill(CGRect(x: centerX - putWidth, y: y - 2.5, width: putWidth, height: 5))
                context.setFillColor(
                    OptionsAnalyticsPresentation.callColor
                        .withAlphaComponent(liquidityAlpha(strike.call?.relativeSpread))
                        .cgColor
                )
                context.fill(CGRect(x: centerX, y: y - 2.5, width: callWidth, height: 5))
            }

            if settings.showMarkedOi, normalization.markedOiValue > 0 {
                let callOiWidth = maximumWidth * OptionsAnalyticsPresentation.magnitudeFraction(
                    value: strike.call?.markedOiValue ?? 0,
                    maximum: normalization.markedOiValue
                )
                let putOiWidth = maximumWidth * OptionsAnalyticsPresentation.magnitudeFraction(
                    value: strike.put?.markedOiValue ?? 0,
                    maximum: normalization.markedOiValue
                )
                let oiY = settings.showGammaProfile ? y + 4 : y
                context.setFillColor(OptionsAnalyticsPresentation.markedOiPutColor.cgColor)
                context.fill(CGRect(x: centerX - putOiWidth, y: oiY - 1.5, width: putOiWidth, height: 3))
                context.setFillColor(OptionsAnalyticsPresentation.markedOiCallColor.cgColor)
                context.fill(CGRect(x: centerX, y: oiY - 1.5, width: callOiWidth, height: 3))
            }
            if settings.showLiquidity {
                drawLiquidity(
                    call: strike.call,
                    put: strike.put,
                    y: y + (settings.showGammaProfile ? 7 : settings.showMarkedOi ? 5 : 0),
                    rail: rail
                )
            }
        }
    }

    private func drawRanges(
        snapshot: OptionsAnalyticsSnapshotDTO,
        rail: CGRect,
        content: CGRect,
        in context: CGContext
    ) {
        guard settings.showImpliedRange, let range = snapshot.impliedRange else { return }
        drawRailLine(
            RailLine(price: range.lower, label: "68% L", color: OptionsAnalyticsPresentation.rangeColor, dashed: true),
            rail: rail,
            content: content,
            in: context
        )
        drawRailLine(
            RailLine(price: range.upper, label: "68% U", color: OptionsAnalyticsPresentation.rangeColor, dashed: true),
            rail: rail,
            content: content,
            in: context
        )
        drawRailLine(
            RailLine(price: range.straddleLower, label: "BE L", color: .white.withAlphaComponent(0.62), dashed: true),
            rail: rail,
            content: content,
            in: context
        )
        drawRailLine(
            RailLine(price: range.straddleUpper, label: "BE U", color: .white.withAlphaComponent(0.62), dashed: true),
            rail: rail,
            content: content,
            in: context
        )
    }

    private func drawWalls(
        snapshot: OptionsAnalyticsSnapshotDTO,
        rail: CGRect,
        content: CGRect,
        in context: CGContext
    ) {
        if let callWall = snapshot.structure.callWall {
            drawRailLine(
                RailLine(price: callWall, label: "CALL WALL", color: OptionsAnalyticsPresentation.callColor, dashed: false),
                rail: rail,
                content: content,
                in: context
            )
        }
        if let putWall = snapshot.structure.putWall {
            drawRailLine(
                RailLine(price: putWall, label: "PUT WALL", color: OptionsAnalyticsPresentation.putColor, dashed: false),
                rail: rail,
                content: content,
                in: context
            )
        }
        if settings.showMarkedOi,
           let maxOpenInterestStrike = snapshot.structure.maxOpenInterestStrike {
            drawRailLine(
                RailLine(
                    price: maxOpenInterestStrike,
                    label: "MAX OI NODE",
                    color: OptionsAnalyticsPresentation.markedOiPutColor,
                    dashed: true
                ),
                rail: rail,
                content: content,
                in: context
            )
        }
    }

    private func drawProxyRoots(
        snapshot: OptionsAnalyticsSnapshotDTO,
        rail: CGRect,
        content: CGRect,
        in context: CGContext
    ) {
        guard let proxy = snapshot.scenarios.callPutDealerProxy else { return }
        for (index, root) in proxy.gammaRoots.enumerated() {
            let label = root == proxy.primaryGammaRoot
                ? "GAMMA FLIP PROXY *"
                : "GAMMA ROOT PROXY \(index + 1)"
            drawRailLine(
                RailLine(price: root, label: label, color: OptionsAnalyticsPresentation.proxyColor, dashed: true),
                rail: rail,
                content: content,
                in: context
            )
        }
    }

    private func drawRailLine(
        _ line: RailLine,
        rail: CGRect,
        content: CGRect,
        in context: CGContext
    ) {
        guard let y = yPixel(for: line.price, in: content) else { return }
        context.setStrokeColor(line.color.cgColor)
        context.setLineWidth(1)
        context.setLineDash(phase: 0, lengths: line.dashed ? [4, 3] : [])
        context.move(to: CGPoint(x: content.minX, y: y))
        context.addLine(to: CGPoint(x: content.maxX, y: y))
        context.strokePath()
        context.setLineDash(phase: 0, lengths: [])
        let text = line.label as NSString
        let attributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.systemFont(ofSize: 7, weight: .bold),
            .foregroundColor: line.color,
        ]
        let origin = CGPoint(x: rail.minX + 3, y: y - 11)
        let size = text.size(withAttributes: attributes)
        // Backing pill keeps labels legible where lines and profile bars overlap.
        context.setFillColor(UIColor.black.withAlphaComponent(0.6).cgColor)
        context.fill(
            CGRect(x: origin.x - 2, y: origin.y - 1, width: size.width + 4, height: size.height + 2)
        )
        text.draw(at: origin, withAttributes: attributes)
    }

    private func liquidityAlpha(_ relativeSpread: Double?) -> CGFloat {
        guard settings.showLiquidity, let relativeSpread else { return 0.72 }
        return min(1, max(0.35, 1 - relativeSpread))
    }

    private func drawLiquidity(
        call: OptionsAnalyticsLegDTO?,
        put: OptionsAnalyticsLegDTO?,
        y: CGFloat,
        rail: CGRect
    ) {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.monospacedSystemFont(ofSize: 6, weight: .medium),
            .foregroundColor: UIColor.white.withAlphaComponent(0.82),
        ]
        let putText = "P \(percentText(put?.relativeSpread))" as NSString
        let callText = "C \(percentText(call?.relativeSpread))" as NSString
        putText.draw(at: CGPoint(x: rail.minX + 2, y: y), withAttributes: attributes)
        callText.draw(
            at: CGPoint(x: rail.maxX - callText.size(withAttributes: attributes).width - 2, y: y),
            withAttributes: attributes
        )
    }

    private func percentText(_ value: Double?) -> String {
        value.map { String(format: "%.1f%%", $0 * 100) } ?? "n/a"
    }

    private func drawRailKey(rail: CGRect, in context: CGContext) {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.monospacedSystemFont(ofSize: 7, weight: .bold),
            .foregroundColor: UIColor.white.withAlphaComponent(0.75),
        ]
        let putKey = "P ◀" as NSString
        let callKey = "▶ C" as NSString
        let baseline = rail.maxY - 13
        putKey.draw(at: CGPoint(x: rail.minX + 3, y: baseline), withAttributes: attributes)
        callKey.draw(
            at: CGPoint(x: rail.maxX - callKey.size(withAttributes: attributes).width - 3, y: baseline),
            withAttributes: attributes
        )
        var layerLabels: [String] = []
        if settings.showMarkedOi { layerLabels.append("OI P/C") }
        if settings.showLiquidity { layerLabels.append("LIQ %") }
        if !layerLabels.isEmpty {
            (layerLabels.joined(separator: " ") as NSString).draw(
                at: CGPoint(x: rail.minX + 3, y: baseline - 10),
                withAttributes: attributes
            )
        }
    }
}
