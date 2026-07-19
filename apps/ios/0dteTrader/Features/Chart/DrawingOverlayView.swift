import Combine
import DGCharts
import UIKit

/// Drawing-canvas metrics (pt values).
///
/// NOTE: belongs in the design system as `AppCanvas`; the foundation is
/// frozen for this pass, so the namespace lives here for now.
enum AppCanvas {
    static let handleRadius: CGFloat = 5
    /// Hit slop for lines, handles and alerts (yields 44pt touch targets).
    static let hitSlop: CGFloat = 22
    static let strokeNormal: CGFloat = 1.25
    static let strokeSelected: CGFloat = 2
    static let strokeAlert: CGFloat = 1
    static let handleRingWidth: CGFloat = 1.5
    static let alertDash: [CGFloat] = [5, 4]
    static let rectFillAlpha: CGFloat = 0.12
    static let tagCornerRadius: CGFloat = 4
    static let tagPaddingH: CGFloat = 4
    static let tagPaddingV: CGFloat = 2
    /// Minimum on-screen length for a drag-placed drawing to be kept.
    static let minDrawingLength: CGFloat = 12
    /// Magnet: snap anchors to a candle's OHLC within this pixel distance.
    static let magnetDistance: CGFloat = 12
}

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
    var firstTime: TimeInterval = 0
    var intervalSeconds: TimeInterval = 60
    /// Candles backing the chart, used for magnet snap-to-OHLC on anchors.
    var candles: [Candle] = []

    /// The annotations model. Redraws are change-driven: model publications
    /// plus chart-transform callbacks from CandleChartRepresentable's
    /// coordinator (no free-running display link).
    var model: ChartDrawingsModel? {
        didSet {
            cancellables = []
            if let model {
                model.$drawings
                    .sink { [weak self] _ in self?.modelDidChange() }
                    .store(in: &cancellables)
                model.$alerts
                    .sink { [weak self] _ in self?.modelDidChange() }
                    .store(in: &cancellables)
                model.$selectedId
                    .sink { [weak self] _ in self?.modelDidChange() }
                    .store(in: &cancellables)
            }
            modelDidChange()
        }
    }

    private var cancellables: Set<AnyCancellable> = []
    private var draft: ChartDrawing? {
        didSet { setNeedsDisplay() }
    }

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

    // Dynamic token twin from DesignSystem/AppColors.swift (dark + light).
    private let accentColor: UIColor = .appAccent
    private let alertColor = UIColor.appWarning
    /// Handle fill contrasts the chart surface in both themes.
    private let handleFillColor = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor.white
            : UIColor(white: 0.11, alpha: 1)
    }

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

    override func layoutSubviews() {
        super.layoutSubviews()
        setNeedsDisplay()
    }

    private func modelDidChange() {
        setNeedsDisplay()
        rebuildAccessibilityElements()
    }

    // In cursor mode, claim only touches near a shape so the chart keeps its
    // pan/zoom everywhere else.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        guard let model else { return false }
        if model.tool != .cursor { return bounds.contains(point) }
        return hitTest(at: point) != nil
    }

    // MARK: - Accessibility

    /// Synthesizes one accessibility element per drawing/alert so VoiceOver
    /// users can perceive annotations; frames include the 44pt hit slop.
    private func rebuildAccessibilityElements() {
        guard let model else {
            accessibilityElements = nil
            return
        }
        var elements: [UIAccessibilityElement] = []
        for drawing in model.drawings {
            guard let a = pixel(for: drawing.p1) else { continue }
            let b = drawing.p2.flatMap { pixel(for: $0) } ?? a
            let element = UIAccessibilityElement(accessibilityContainer: self)
            element.accessibilityLabel = "\(drawing.kind.rawValue) at \(Format.price(drawing.p1.price))"
            element.accessibilityTraits = .button
            element.accessibilityHint = "Double-tap to select"
            element.accessibilityFrameInContainerSpace = CGRect(
                x: min(a.x, b.x) - AppCanvas.hitSlop,
                y: min(a.y, b.y) - AppCanvas.hitSlop,
                width: abs(b.x - a.x) + AppCanvas.hitSlop * 2,
                height: max(abs(b.y - a.y) + AppCanvas.hitSlop * 2, 44)
            )
            elements.append(element)
        }
        for alert in model.alerts {
            guard let p = pixel(for: DrawingPoint(time: firstTime, price: alert.price)) else { continue }
            let element = UIAccessibilityElement(accessibilityContainer: self)
            element.accessibilityLabel = alert.firedAt == nil
                ? "Price alert at \(Format.price(alert.price))"
                : "Fired price alert at \(Format.price(alert.price))"
            element.accessibilityTraits = .button
            element.accessibilityFrameInContainerSpace = CGRect(
                x: 0,
                y: p.y - AppCanvas.hitSlop,
                width: bounds.width,
                height: 44
            )
            elements.append(element)
        }
        accessibilityElements = elements
    }

    // MARK: - Coordinate mapping

    private func pixel(for point: DrawingPoint) -> CGPoint? {
        guard let chart else { return nil }
        let index = intervalSeconds > 0 ? (point.time - firstTime) / intervalSeconds : 0
        let pixelPoint = chart.getTransformer(forAxis: .left).pixelForValues(x: index, y: point.price)
        guard pixelPoint.x.isFinite, pixelPoint.y.isFinite else { return nil }
        return pixelPoint
    }

    private func dataPoint(at touchPoint: CGPoint) -> DrawingPoint {
        guard let chart else { return DrawingPoint(time: firstTime, price: 0) }
        let value = chart.getTransformer(forAxis: .left).valueForTouchPoint(touchPoint)
        var point = DrawingPoint(
            time: firstTime + Double(value.x) * intervalSeconds,
            price: Double(value.y)
        )
        guard intervalSeconds > 0 else { return point }
        // Magnet: snap to the nearest OHLC of the touched candle when the
        // anchor lands within `magnetDistance` of it.
        let index = Int(((point.time - firstTime) / intervalSeconds).rounded())
        guard candles.indices.contains(index) else { return point }
        let candle = candles[index]
        let candidates = [candle.open, candle.high, candle.low, candle.close]
        if let nearest = candidates.min(by: { abs($0 - point.price) < abs($1 - point.price) }),
           let snapped = pixel(for: DrawingPoint(time: point.time, price: nearest)),
           abs(snapped.y - touchPoint.y) <= AppCanvas.magnetDistance {
            point.price = nearest
        }
        return point
    }

    // MARK: - Gestures

    @objc private func handleTap(_ recognizer: UITapGestureRecognizer) {
        guard let model else { return }
        let location = recognizer.location(in: self)
        switch model.tool {
        case .hline:
            let point = dataPoint(at: location)
            model.add(ChartDrawing(id: UUID(), kind: .hline, p1: point, p2: nil))
            Haptics.impact(.light)
        case .alert:
            model.addAlert(price: dataPoint(at: location).price)
            Haptics.impact(.light)
        case .cursor:
            let hit = hitTest(at: location)
            model.selectedId = hit?.id
            if hit != nil { Haptics.selection() }
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
                // Reject tap-like micro-drags so invisible zero-length shapes
                // never get persisted.
                var length: CGFloat = 0
                if let a = pixel(for: finished.p1), let p2 = finished.p2, let b = pixel(for: p2) {
                    length = hypot(b.x - a.x, b.y - a.y)
                }
                if length >= AppCanvas.minDrawingLength {
                    model.add(finished)
                    Haptics.impact(.light)
                }
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
            Haptics.selection()
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
               abs(point.y - pixelPoint.y) <= AppCanvas.hitSlop {
                return (alert.id, .alert)
            }
        }
        for drawing in model.drawings.reversed() {
            guard let a = pixel(for: drawing.p1) else { continue }
            let b = drawing.p2.flatMap { pixel(for: $0) }
            if hypot(point.x - a.x, point.y - a.y) <= AppCanvas.hitSlop {
                return (drawing.id, .p1)
            }
            if let b, hypot(point.x - b.x, point.y - b.y) <= AppCanvas.hitSlop {
                return (drawing.id, .p2)
            }
            switch drawing.kind {
            case .hline:
                if abs(point.y - a.y) <= AppCanvas.hitSlop { return (drawing.id, .whole) }
            case .rect:
                guard let b else { continue }
                let rect = CGRect(
                    x: min(a.x, b.x), y: min(a.y, b.y),
                    width: abs(b.x - a.x), height: abs(b.y - a.y)
                ).insetBy(dx: -3, dy: -3)
                if rect.contains(point) { return (drawing.id, .whole) }
            case .trend, .ray:
                guard let b else { continue }
                let end = drawing.kind == .ray ? rayEnd(from: a, through: b) : b
                if segmentDistance(point, a, end) <= AppCanvas.hitSlop { return (drawing.id, .whole) }
            }
        }
        return nil
    }

    /// Extends a ray parametrically only to the bounds edge, so strokes and
    /// hit tests never run tens of thousands of points off screen.
    private func rayEnd(from a: CGPoint, through b: CGPoint) -> CGPoint {
        let d = CGPoint(x: b.x - a.x, y: b.y - a.y)
        guard d.x != 0 || d.y != 0 else { return b }
        var t = CGFloat.greatestFiniteMagnitude
        if d.x > 0 { t = min(t, (bounds.width - a.x) / d.x) }
        if d.x < 0 { t = min(t, -a.x / d.x) }
        if d.y > 0 { t = min(t, (bounds.height - a.y) / d.y) }
        if d.y < 0 { t = min(t, -a.y / d.y) }
        return CGPoint(x: a.x + d.x * t, y: a.y + d.y * t)
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
            renderAlert(alert: alert, selected: alert.id == model.selectedId, in: context)
        }
    }

    private func render(_ drawing: ChartDrawing, selected: Bool, in context: CGContext) {
        context.setStrokeColor(accentColor.cgColor)
        context.setLineWidth(selected ? AppCanvas.strokeSelected : AppCanvas.strokeNormal)
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
            context.setFillColor(accentColor.withAlphaComponent(AppCanvas.rectFillAlpha).cgColor)
            context.fill(rect)
            context.stroke(rect)
            if selected {
                renderHandle(at: a, in: context)
                renderHandle(at: b, in: context)
            }

        case .trend, .ray:
            guard let p2 = drawing.p2, let b = pixel(for: p2) else { return }
            let end = drawing.kind == .ray ? rayEnd(from: a, through: b) : b
            context.move(to: a)
            context.addLine(to: end)
            context.strokePath()
            if selected {
                renderHandle(at: a, in: context)
                renderHandle(at: b, in: context)
            }
        }
    }

    private func renderAlert(alert: PriceAlert, selected: Bool, in context: CGContext) {
        guard let point = pixel(for: DrawingPoint(time: firstTime, price: alert.price)) else { return }
        let isFired = alert.firedAt != nil
        // Fired alerts stay on the chart dimmed until the user deletes them.
        let color = isFired ? alertColor.withAlphaComponent(0.35) : alertColor
        context.setStrokeColor(color.cgColor)
        context.setLineWidth(selected ? AppCanvas.strokeSelected : AppCanvas.strokeAlert)
        context.setLineDash(phase: 0, lengths: AppCanvas.alertDash)
        context.move(to: CGPoint(x: 0, y: point.y))
        context.addLine(to: CGPoint(x: bounds.width, y: point.y))
        context.strokePath()
        context.setLineDash(phase: 0, lengths: [])
        renderPriceTag(price: alert.price, y: point.y, color: color, showsBell: !isFired, in: context)
    }

    /// Price tag pinned to the right edge inside the plot (clear of the left
    /// axis labels), Dynamic Type-scaled, with rounded corners. Alerts get a
    /// small bell glyph instead of an emoji prefix.
    private func renderPriceTag(
        price: Double,
        y: CGFloat,
        color: UIColor,
        showsBell: Bool = false,
        in context: CGContext
    ) {
        let font = UIFontMetrics(forTextStyle: .caption2)
            .scaledFont(for: UIFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium))
        let label = Format.price(price) as NSString
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: UIColor.black,
        ]
        let size = label.size(withAttributes: attributes)
        let bell = showsBell
            ? UIImage(systemName: "bell.fill")?
                .withConfiguration(UIImage.SymbolConfiguration(pointSize: 8, weight: .bold))
                .withTintColor(.black, renderingMode: .alwaysOriginal)
            : nil
        let bellWidth = bell.map { $0.size.width + 2 } ?? 0
        let background = CGRect(
            x: bounds.width - size.width - bellWidth - AppCanvas.tagPaddingH * 2 - 4,
            y: y - size.height / 2 - AppCanvas.tagPaddingV,
            width: size.width + bellWidth + AppCanvas.tagPaddingH * 2,
            height: size.height + AppCanvas.tagPaddingV * 2
        )
        let path = UIBezierPath(roundedRect: background, cornerRadius: AppCanvas.tagCornerRadius)
        context.setFillColor(color.cgColor)
        context.addPath(path.cgPath)
        context.fillPath()
        var labelX = background.minX + AppCanvas.tagPaddingH
        if let bell {
            bell.draw(at: CGPoint(x: labelX, y: background.midY - bell.size.height / 2))
            labelX += bellWidth
        }
        label.draw(at: CGPoint(x: labelX, y: background.minY + AppCanvas.tagPaddingV), withAttributes: attributes)
    }

    private func renderHandle(at point: CGPoint, in context: CGContext) {
        let rect = CGRect(
            x: point.x - AppCanvas.handleRadius, y: point.y - AppCanvas.handleRadius,
            width: AppCanvas.handleRadius * 2, height: AppCanvas.handleRadius * 2
        )
        context.setFillColor(handleFillColor.cgColor)
        context.fillEllipse(in: rect)
        context.setStrokeColor(accentColor.cgColor)
        context.setLineWidth(AppCanvas.handleRingWidth)
        context.strokeEllipse(in: rect)
    }
}
