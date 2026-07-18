import Charts
import UIKit

/// Annotation canvas layered above the candle chart: renders and edits trend
/// lines, rays, horizontal lines, boxes and alert lines anchored to
/// (time, price). Uses the chart's transformer for both directions, so shapes
/// track pan/zoom and live candle updates.
///
/// Touch routing: with a draw tool active the whole overlay owns touches;
/// in cursor mode only touches near a shape are claimed (select/drag), and
/// everything else falls through to the chart's own pan/zoom.
final class DrawingOverlayView: UIView {
    weak var chart: CombinedChartView?
    var model: ChartDrawingsModel?
    var firstTime: TimeInterval = 0
    var intervalSeconds: TimeInterval = 60

    private var displayLink: CADisplayLink?
    private var draft: ChartDrawing?

    private enum DragMode {
        case whole
        case p1
        case p2
        case alert
    }

    private struct DragState {
        let id: UUID
        let mode: DragMode
        let startPoint: DrawingPoint
        let origP1: DrawingPoint
        let origP2: DrawingPoint?
    }

    private var drag: DragState?

    private let accentColor = UIColor(red: 0.337, green: 0.561, blue: 0.969, alpha: 1)
    private let alertColor = UIColor.systemOrange
    private let handleRadius: CGFloat = 5
    private let hitDistance: CGFloat = 10

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isOpaque = false

        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
        pan.maximumNumberOfTouches = 1
        addGestureRecognizer(pan)
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(handleTap(_:))))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        displayLink?.invalidate()
        displayLink = nil
        if window != nil {
            let link = CADisplayLink(target: self, selector: #selector(tick))
            link.preferredFramesPerSecond = 30
            link.add(to: .main, forMode: .common)
            displayLink = link
        }
    }

    @objc private func tick() {
        setNeedsDisplay()
    }

    // In cursor mode, claim only touches near a shape so the chart keeps its
    // pan/zoom everywhere else.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        guard let model else { return false }
        if model.tool != .cursor { return bounds.contains(point) }
        return hitTest(at: point) != nil
    }

    // MARK: - Coordinate mapping

    private func pixel(for point: DrawingPoint) -> CGPoint? {
        guard let chart else { return nil }
        let index = intervalSeconds > 0 ? (point.time - firstTime) / intervalSeconds : 0
        let pixelPoint = chart.getTransformer(forAxis: .left).pixelForValues(x: index, y: point.price)
        guard pixelPoint.x.isFinite, pixelPoint.y.isFinite else { return nil }
        return pixelPoint
    }

    private func dataPoint(at pixel: CGPoint) -> DrawingPoint {
        guard let chart else { return DrawingPoint(time: firstTime, price: 0) }
        let value = chart.getTransformer(forAxis: .left).valueForTouchPoint(pixel)
        return DrawingPoint(
            time: firstTime + Double(value.x) * intervalSeconds,
            price: Double(value.y)
        )
    }

    // MARK: - Gestures

    @objc private func handleTap(_ recognizer: UITapGestureRecognizer) {
        guard let model else { return }
        let location = recognizer.location(in: self)
        switch model.tool {
        case .hline:
            let point = dataPoint(at: location)
            model.add(ChartDrawing(id: UUID(), kind: .hline, p1: point, p2: nil))
        case .alert:
            model.addAlert(price: dataPoint(at: location).price)
        case .cursor:
            model.selectedId = hitTest(at: location)?.id
        case .trend, .ray, .rect:
            break // Placed by drag.
        }
    }

    @objc private func handlePan(_ recognizer: UIPanGestureRecognizer) {
        guard let model else { return }
        let location = recognizer.location(in: self)

        if model.tool == .cursor {
            handleCursorPan(recognizer, model: model, location: location)
            return
        }

        let kind: ChartDrawing.Kind?
        switch model.tool {
        case .trend: kind = .trend
        case .ray: kind = .ray
        case .rect: kind = .rect
        default: kind = nil
        }
        guard let kind else { return }

        switch recognizer.state {
        case .began:
            let point = dataPoint(at: location)
            draft = ChartDrawing(id: UUID(), kind: kind, p1: point, p2: point)
        case .changed:
            draft?.p2 = dataPoint(at: location)
        case .ended:
            if var finished = draft {
                finished.p2 = dataPoint(at: location)
                model.add(finished)
            }
            draft = nil
        case .cancelled, .failed:
            draft = nil
            model.tool = .cursor
        default:
            break
        }
    }

    private func handleCursorPan(
        _ recognizer: UIPanGestureRecognizer,
        model: ChartDrawingsModel,
        location: CGPoint
    ) {
        switch recognizer.state {
        case .began:
            guard let hit = hitTest(at: location) else { return }
            model.selectedId = hit.id
            let start = dataPoint(at: location)
            if let drawing = model.drawings.first(where: { $0.id == hit.id }) {
                drag = DragState(
                    id: hit.id, mode: hit.mode, startPoint: start,
                    origP1: drawing.p1, origP2: drawing.p2
                )
            } else if let alert = model.alerts.first(where: { $0.id == hit.id }) {
                drag = DragState(
                    id: hit.id, mode: .alert, startPoint: start,
                    origP1: DrawingPoint(time: start.time, price: alert.price), origP2: nil
                )
            }
        case .changed:
            guard let drag else { return }
            let current = dataPoint(at: location)
            let deltaTime = current.time - drag.startPoint.time
            let deltaPrice = current.price - drag.startPoint.price
            switch drag.mode {
            case .alert:
                model.updateAlert(id: drag.id, price: drag.origP1.price + deltaPrice)
            case .p1:
                model.update(id: drag.id, p1: current, p2: drag.origP2)
            case .p2:
                model.update(id: drag.id, p1: drag.origP1, p2: current)
            case .whole:
                let movedP1 = DrawingPoint(
                    time: drag.origP1.time + deltaTime,
                    price: drag.origP1.price + deltaPrice
                )
                let movedP2 = drag.origP2.map {
                    DrawingPoint(time: $0.time + deltaTime, price: $0.price + deltaPrice)
                }
                model.update(id: drag.id, p1: movedP1, p2: movedP2)
            }
        default:
            drag = nil
        }
    }

    // MARK: - Hit testing

    private func hitTest(at point: CGPoint) -> (id: UUID, mode: DragMode)? {
        guard let model else { return nil }
        for alert in model.alerts.reversed() {
            if let pixelPoint = pixel(for: DrawingPoint(time: firstTime, price: alert.price)),
               abs(point.y - pixelPoint.y) <= hitDistance {
                return (alert.id, .alert)
            }
        }
        for drawing in model.drawings.reversed() {
            guard let a = pixel(for: drawing.p1) else { continue }
            let b = drawing.p2.flatMap { pixel(for: $0) }
            if hypot(point.x - a.x, point.y - a.y) <= handleRadius + 5 {
                return (drawing.id, .p1)
            }
            if let b, hypot(point.x - b.x, point.y - b.y) <= handleRadius + 5 {
                return (drawing.id, .p2)
            }
            switch drawing.kind {
            case .hline:
                if abs(point.y - a.y) <= hitDistance { return (drawing.id, .whole) }
            case .rect:
                guard let b else { continue }
                let rect = CGRect(
                    x: min(a.x, b.x), y: min(a.y, b.y),
                    width: abs(b.x - a.x), height: abs(b.y - a.y)
                ).insetBy(dx: -3, dy: -3)
                if rect.contains(point) { return (drawing.id, .whole) }
            case .trend, .ray:
                guard let b else { continue }
                var end = b
                if drawing.kind == .ray, a != b {
                    end = CGPoint(x: a.x + (b.x - a.x) * 100, y: a.y + (b.y - a.y) * 100)
                }
                if segmentDistance(point, a, end) <= hitDistance { return (drawing.id, .whole) }
            }
        }
        return nil
    }

    private func segmentDistance(_ p: CGPoint, _ a: CGPoint, _ b: CGPoint) -> CGFloat {
        let lengthSquared = (b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y)
        guard lengthSquared > 0 else { return hypot(p.x - a.x, p.y - a.y) }
        var t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / lengthSquared
        t = max(0, min(1, t))
        return hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)))
    }

    // MARK: - Rendering

    override func draw(_ rect: CGRect) {
        guard let model, let context = UIGraphicsGetCurrentContext() else { return }
        for drawing in model.drawings {
            render(drawing, selected: drawing.id == model.selectedId, in: context)
        }
        if let draft {
            render(draft, selected: false, in: context)
        }
        for alert in model.alerts {
            renderAlert(price: alert.price, selected: alert.id == model.selectedId, in: context)
        }
    }

    private func render(_ drawing: ChartDrawing, selected: Bool, in context: CGContext) {
        context.setStrokeColor(accentColor.cgColor)
        context.setLineWidth(selected ? 2 : 1.25)
        context.setLineDash(phase: 0, lengths: [])
        guard let a = pixel(for: drawing.p1) else { return }

        switch drawing.kind {
        case .hline:
            context.move(to: CGPoint(x: 0, y: a.y))
            context.addLine(to: CGPoint(x: bounds.width, y: a.y))
            context.strokePath()
            renderPriceTag(price: drawing.p1.price, y: a.y, color: accentColor, in: context)
            if selected { renderHandle(at: CGPoint(x: a.x, y: a.y), in: context) }

        case .rect:
            guard let p2 = drawing.p2, let b = pixel(for: p2) else { return }
            let rect = CGRect(
                x: min(a.x, b.x), y: min(a.y, b.y),
                width: abs(b.x - a.x), height: abs(b.y - a.y)
            )
            context.setFillColor(accentColor.withAlphaComponent(0.12).cgColor)
            context.fill(rect)
            context.stroke(rect)
            if selected {
                renderHandle(at: a, in: context)
                renderHandle(at: b, in: context)
            }

        case .trend, .ray:
            guard let p2 = drawing.p2, let b = pixel(for: p2) else { return }
            var end = b
            if drawing.kind == .ray, a != b {
                end = CGPoint(x: a.x + (b.x - a.x) * 100, y: a.y + (b.y - a.y) * 100)
            }
            context.move(to: a)
            context.addLine(to: end)
            context.strokePath()
            if selected {
                renderHandle(at: a, in: context)
                renderHandle(at: b, in: context)
            }
        }
    }

    private func renderAlert(price: Double, selected: Bool, in context: CGContext) {
        guard let point = pixel(for: DrawingPoint(time: firstTime, price: price)) else { return }
        context.setStrokeColor(alertColor.cgColor)
        context.setLineWidth(selected ? 2 : 1)
        context.setLineDash(phase: 0, lengths: [5, 4])
        context.move(to: CGPoint(x: 0, y: point.y))
        context.addLine(to: CGPoint(x: bounds.width, y: point.y))
        context.strokePath()
        context.setLineDash(phase: 0, lengths: [])
        renderPriceTag(price: price, y: point.y, color: alertColor, prefix: "⏰ ", in: context)
    }

    private func renderPriceTag(
        price: Double,
        y: CGFloat,
        color: UIColor,
        prefix: String = "",
        in context: CGContext
    ) {
        let label = "\(prefix)\(Format.price(price))" as NSString
        let attributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.monospacedDigitSystemFont(ofSize: 10, weight: .medium),
            .foregroundColor: UIColor.black,
        ]
        let size = label.size(withAttributes: attributes)
        let background = CGRect(x: 4, y: y - size.height / 2 - 2, width: size.width + 8, height: size.height + 4)
        context.setFillColor(color.cgColor)
        context.fill(background)
        label.draw(at: CGPoint(x: background.minX + 4, y: background.minY + 2), withAttributes: attributes)
    }

    private func renderHandle(at point: CGPoint, in context: CGContext) {
        let rect = CGRect(
            x: point.x - handleRadius, y: point.y - handleRadius,
            width: handleRadius * 2, height: handleRadius * 2
        )
        context.setFillColor(UIColor.white.cgColor)
        context.fillEllipse(in: rect)
        context.setStrokeColor(accentColor.cgColor)
        context.setLineWidth(1.5)
        context.strokeEllipse(in: rect)
    }
}
