import DGCharts
import UIKit

/// Read-only CoreGraphics overlay for the TWC Heatmap render model: fib level
/// lines, Gann fans/frames, profit-target bands, labels, signal markers and
/// area fills (TwcOverlay.tsx analog). Sits between the chart and the
/// interactive DrawingOverlayView; bar indices map straight through the
/// chart's left-axis transformer, including indices past the last bar
/// (forward projection).
final class TwcOverlayView: UIView {
    weak var chart: CombinedChartView?
    var model: TwcRenderModel? {
        didSet { if model != oldValue { setNeedsDisplay() } }
    }
    var candles: [Candle] = []

    private static let markerPad: CGFloat = 6

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

    private func pixel(x: Double, y: Double) -> CGPoint? {
        guard let chart else { return nil }
        let point = chart.getTransformer(forAxis: .left).pixelForValues(x: x, y: y)
        guard point.x.isFinite, point.y.isFinite else { return nil }
        return point
    }

    // swiftlint:disable:next function_body_length cyclomatic_complexity
    override func draw(_ rect: CGRect) {
        guard let model, let chart, !candles.isEmpty,
              let context = UIGraphicsGetCurrentContext()
        else { return }

        // Clip to the plot area so projections never spill over the axes.
        context.clip(to: chart.viewPortHandler.contentRect)

        // ── Area fills (contiguous same-color runs between two series) ──
        for fill in model.fills {
            var run: [(x: CGFloat, top: CGFloat, bottom: CGFloat)] = []
            // swiftlint:disable:previous large_tuple
            var runColor: String?
            func flush() {
                defer {
                    run = []
                    runColor = nil
                }
                guard run.count >= 2, let colorString = runColor else { return }
                let path = CGMutablePath()
                path.move(to: CGPoint(x: run[0].x, y: run[0].top))
                for p in run.dropFirst() { path.addLine(to: CGPoint(x: p.x, y: p.top)) }
                for p in run.reversed() { path.addLine(to: CGPoint(x: p.x, y: p.bottom)) }
                path.closeSubpath()
                context.addPath(path)
                context.setFillColor(UIColor(twcColor: colorString).cgColor)
                context.fillPath()
            }
            for i in 0..<candles.count {
                guard let top = fill.top[i], let bottom = fill.bottom[i], let color = fill.colors[i] else {
                    flush()
                    continue
                }
                if runColor != nil, color != runColor { flush() }
                guard let pTop = pixel(x: Double(i), y: top), let pBottom = pixel(x: Double(i), y: bottom) else {
                    flush()
                    continue
                }
                runColor = color
                run.append((x: pTop.x, top: pTop.y, bottom: pBottom.y))
            }
            flush()
        }

        // ── Bands (PT zones, order blocks, premium/discount zones) ──
        for band in model.bands {
            guard let a = pixel(x: band.x1, y: band.yTop), let b = pixel(x: band.x2, y: band.yBottom) else { continue }
            let rect = CGRect(
                x: min(a.x, b.x),
                y: min(a.y, b.y),
                width: abs(b.x - a.x),
                height: abs(b.y - a.y)
            )
            context.setFillColor(UIColor(twcColor: band.fillColor).cgColor)
            context.fill(rect)
            if let border = band.borderColor {
                context.setStrokeColor(UIColor(twcColor: border).cgColor)
                context.setLineWidth(1)
                context.setLineDash(phase: 0, lengths: [])
                context.stroke(rect)
            }
        }

        // ── Segments (fib levels, Gann fans/frames) ──
        for segment in model.segments {
            guard let a = pixel(x: segment.x1, y: segment.y1), let b = pixel(x: segment.x2, y: segment.y2) else { continue }
            context.setStrokeColor(UIColor(twcColor: segment.color).cgColor)
            context.setLineWidth(CGFloat(segment.width))
            switch segment.style {
            case .dashed: context.setLineDash(phase: 0, lengths: [5, 4])
            case .dotted: context.setLineDash(phase: 0, lengths: [2, 3])
            case .solid: context.setLineDash(phase: 0, lengths: [])
            }
            context.move(to: a)
            context.addLine(to: b)
            context.strokePath()
        }
        context.setLineDash(phase: 0, lengths: [])

        // ── Labels ──
        let labelFont = UIFont.systemFont(ofSize: 10, weight: .medium)
        for label in model.labels {
            guard let p = pixel(x: label.barIndex, y: label.price) else { continue }
            let text = label.text as NSString
            let attributes: [NSAttributedString.Key: Any] = [
                .font: labelFont,
                .foregroundColor: UIColor(twcColor: label.textColor),
            ]
            let size = text.size(withAttributes: attributes)
            let drawX: CGFloat
            switch label.align {
            case .center: drawX = p.x - size.width / 2
            case .right: drawX = p.x - size.width
            case .left: drawX = p.x
            }
            if let bg = label.bgColor {
                let pill = CGRect(x: drawX - 6, y: p.y - 8, width: size.width + 12, height: 16)
                context.setFillColor(UIColor(twcColor: bg).cgColor)
                context.addPath(CGPath(roundedRect: pill, cornerWidth: 4, cornerHeight: 4, transform: nil))
                context.fillPath()
            }
            text.draw(at: CGPoint(x: drawX, y: p.y - size.height / 2), withAttributes: attributes)
        }

        // ── Markers (diamonds, triangles, Buy/Sell pills) ──
        for marker in model.markers {
            guard candles.indices.contains(marker.barIndex) else { continue }
            let bar = candles[marker.barIndex]
            let above = marker.placement == .aboveBar
            guard let anchor = pixel(x: Double(marker.barIndex), y: above ? bar.high : bar.low) else { continue }
            let dir: CGFloat = above ? -1 : 1
            let x = anchor.x
            let y = anchor.y + dir * Self.markerPad
            let s: CGFloat = marker.sizeTiny ? 4 : 5.5
            let color = UIColor(twcColor: marker.color)
            context.setFillColor(color.cgColor)

            switch marker.shape {
            case .diamond:
                context.move(to: CGPoint(x: x, y: y - s + dir * s))
                context.addLine(to: CGPoint(x: x + s, y: y + dir * s))
                context.addLine(to: CGPoint(x: x, y: y + s + dir * s))
                context.addLine(to: CGPoint(x: x - s, y: y + dir * s))
                context.closePath()
                context.fillPath()
            case .triangleUp, .triangleDown:
                // Apex points toward the bar; base extends away from it.
                let base = marker.shape == .triangleUp ? y + 2 * s : y - 2 * s
                context.move(to: CGPoint(x: x, y: y))
                context.addLine(to: CGPoint(x: x - s, y: base))
                context.addLine(to: CGPoint(x: x + s, y: base))
                context.closePath()
                context.fillPath()
            case .labelUp, .labelDown:
                let text = (marker.text ?? "") as NSString
                let attributes: [NSAttributedString.Key: Any] = [
                    .font: labelFont,
                    .foregroundColor: UIColor.white,
                ]
                let size = text.size(withAttributes: attributes)
                let w = size.width + 12
                let h: CGFloat = 16
                let pillY = above ? y - h - 4 : y + 4
                let pill = CGRect(x: x - w / 2, y: pillY, width: w, height: h)
                context.addPath(CGPath(roundedRect: pill, cornerWidth: 4, cornerHeight: 4, transform: nil))
                context.fillPath()
                // Pointer toward the bar
                context.move(to: CGPoint(x: x - 3, y: above ? pillY + h : pillY))
                context.addLine(to: CGPoint(x: x + 3, y: above ? pillY + h : pillY))
                context.addLine(to: CGPoint(x: x, y: above ? pillY + h + 4 : pillY - 4))
                context.closePath()
                context.fillPath()
                text.draw(
                    at: CGPoint(x: x - size.width / 2, y: pillY + (h - size.height) / 2),
                    withAttributes: attributes
                )
            }
        }
    }
}

extension UIColor {
    /// Resolves the compute layer's color strings: "#RRGGBB",
    /// "rgb(r, g, b)" or "rgba(r, g, b, a)".
    convenience init(twcColor: String) {
        let value = twcColor.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("#"), value.count >= 7 {
            let raw = String(value.dropFirst())
            let r = Int(raw.prefix(2), radix: 16) ?? 255
            let g = Int(raw.dropFirst(2).prefix(2), radix: 16) ?? 255
            let b = Int(raw.dropFirst(4).prefix(2), radix: 16) ?? 255
            self.init(red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: 1)
            return
        }
        if value.hasPrefix("rgb") {
            let numbers = value
                .drop(while: { $0 != "(" })
                .trimmingCharacters(in: CharacterSet(charactersIn: "()"))
                .split(separator: ",")
                .compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
            if numbers.count >= 3 {
                self.init(
                    red: CGFloat(numbers[0]) / 255,
                    green: CGFloat(numbers[1]) / 255,
                    blue: CGFloat(numbers[2]) / 255,
                    alpha: numbers.count >= 4 ? CGFloat(numbers[3]) : 1
                )
                return
            }
        }
        self.init(white: 1, alpha: 1)
    }
}
