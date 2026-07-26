import Combine
import DGCharts
import UIKit

/// Order-line metrics (pt values).
enum AppOrderLine {
    static let rowHeight: CGFloat = 22
    static let pillPaddingH: CGFloat = 7
    static let pillGap: CGFloat = 3
    static let pillCornerRadius: CGFloat = 4
    /// Minimum touch target. Adjacent pills split the gap between them rather
    /// than each claiming this on both sides, so the generous target that makes
    /// MID/MKT easy to hit can never eat the edge of ✕ and cancel the order.
    static let minimumTouchTarget: CGFloat = 44
    /// Vertical slop for grabbing the line body itself.
    static let lineHitSlop: CGFloat = 16
    static let rowRightMargin: CGFloat = 8
    static let strokeNormal: CGFloat = 1.25
    static let strokeSelected: CGFloat = 2
    static let strokeEntry: CGFloat = 1.5
    static let stopDash: [CGFloat] = [6, 4]
    /// A bracket drag must travel this far before it places anything.
    static let bracketDragThreshold: CGFloat = 16
}

/// Which control within a row a touch landed on.
enum OrderLinePill: Equatable {
    case quantity
    case kind
    case orderType
    case pnl
    case close
}

/// One control in a row, as laid out and painted.
struct OrderLinePillLayout {
    let pill: OrderLinePill
    let label: String
    /// The drawn pill.
    let frame: CGRect
    /// Enlarged rect used for touches — at least 44pt tall, and never
    /// overlapping a neighbour's.
    let touchFrame: CGRect
}

/// A row as last painted. Hit-testing reads these, so it can never disagree
/// with what is on screen.
struct OrderLineRow {
    enum Target: Equatable {
        /// A chart order line, by id.
        case order(String)
        /// A position's entry line, by contract symbol.
        case entry(String)
    }

    let target: Target
    let y: CGFloat
    /// Left edge of the button row; the line is stroked up to it, not under it.
    let left: CGFloat
    let pills: [OrderLinePillLayout]
}

/// What the overlay needs to draw a position's entry line.
struct EntryLineModel: Equatable {
    let position: Position
    let contract: OptionContract
    let price: Double
}

/// Actions the overlay raises; the SwiftUI layer owns the consequences.
@MainActor
protocol OrderLineOverlayDelegate: AnyObject {
    func orderLineOverlayDidTapCancel(order: ChartOrder)
    func orderLineOverlayDidToggleOrderType(order: ChartOrder)
    func orderLineOverlayDidMove(order: ChartOrder, to price: Double)
    func orderLineOverlayDidTapFlatten(position: Position)
    func orderLineOverlayDidDragBracket(entry: EntryLineModel, to price: Double)
    /// The `+` handle was tapped at this level.
    func orderLineOverlayDidRequestPlacement(at price: Double)
}

/// TradingView-style order lines above the candles: a live entry line per open
/// position (quantity, P/L, and a one-tap close), and every working order line
/// with its quantity, kind, execution type, and cancel.
///
/// Layered above `DrawingOverlayView` so an order line wins the touch —
/// mis-grabbing a trend line when you meant to move a stop is the expensive
/// mistake. Touch routing follows the drawing canvas's rule: only touches on a
/// line or a pill are claimed, and everything else falls through to the chart's
/// own pan and zoom.
final class OrderLineOverlayView: UIView {
    weak var chart: CombinedChartView?
    weak var delegate: OrderLineOverlayDelegate?

    /// Keeps rows clear of the options-analytics rail when it is on.
    var rightInset: CGFloat = 0 { didSet { setNeedsDisplay() } }

    /// The guide's level, or nil when no guide is showing — which is the resting
    /// state: a tap on empty chart space summons it and the next one dismisses
    /// it. Owned here because summoning and dragging it are UIKit gestures;
    /// SwiftUI only hears about it when the `+` is tapped.
    ///
    /// Advanced by `draw(_:)` as well as by the gesture handlers — the paint
    /// pass is what settles it through `resolveGuidePrice` — so the ordering of
    /// drag and paint is load-bearing. Safe because it has no `didSet` and
    /// nothing in the paint path can re-enter drawing.
    var guidePrice: Double?
    /// The handle as last drawn, for hit-testing.
    var handleFrame: CGRect = .zero
    var entryLines: [EntryLineModel] = [] {
        didSet {
            guard entryLines != oldValue else { return }
            setNeedsDisplay()
        }
    }

    var settings: ChartTradingSettings = .default {
        didSet {
            guard settings != oldValue else { return }
            setNeedsDisplay()
        }
    }

    /// Whether there is a contract for a new line to trade. Without one
    /// `ChartTradingCoordinator` drops the placement request on the floor, so
    /// the guide is suppressed rather than drawn as an affordance that does
    /// nothing. Desktop gates its guide on the same condition.
    var hasSelectedContract: Bool = false {
        didSet {
            guard hasSelectedContract != oldValue else { return }
            setNeedsDisplay()
        }
    }

    var model: ChartOrdersModel? {
        didSet {
            cancellables = []
            if let model {
                model.$orders
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
    private var rows: [OrderLineRow] = []

    /// Level the open placement card is armed at, or nil when it is closed.
    /// Driven from SwiftUI state, so while the card is open it — not the
    /// handle — owns the guide's level, and there is one source of truth at any
    /// moment. Closing it hands the level back to `guidePrice`, which has been
    /// tracking it, so the guide keeps the tick-rounded level the card was
    /// armed at rather than reverting to the one the handle was dragged to.
    var placementPrice: Double? {
        didSet {
            guard placementPrice != oldValue else { return }
            setNeedsDisplay()
        }
    }

    private enum Drag {
        case move(orderId: String, price: Double)
        case bracket(entry: EntryLineModel, startY: CGFloat, price: Double, engaged: Bool)
        case guideHandle(startY: CGFloat, moved: Bool)
    }

    private var drag: Drag?

    /// Whether the guide handle is mid-drag and has actually travelled.
    ///
    /// The drag state itself stays private: the placement extension only needs
    /// to know whether to call the level out beside the line, not what else the
    /// view might be dragging.
    var isDraggingGuide: Bool {
        if case .guideHandle(_, true) = drag { return true }
        return false
    }

    private let limitColor: UIColor = .appAccent
    private let positiveColor: UIColor = .appPnlPositive
    private let negativeColor: UIColor = .appPnlNegative
    private let pillTextColor = UIColor.black

    /// One long-lived element for the handle, so VoiceOver focus survives the
    /// repaints that rebuild everything else. `let`, not `var`: reassigning it
    /// would hand VoiceOver a fresh element and drop the focus identity that is
    /// the whole reason it is held rather than rebuilt.
    let guideHandleElement: GuideHandleElement

    override init(frame: CGRect) {
        // The real container is patched in below — `self` does not exist yet —
        // but the element itself is created exactly once, which is the part
        // that matters.
        guideHandleElement = GuideHandleElement(accessibilityContainer: NSNull())
        super.init(frame: frame)
        guideHandleElement.accessibilityContainer = self
        backgroundColor = .clear
        isOpaque = false

        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
        pan.maximumNumberOfTouches = 1
        pan.delegate = self
        addGestureRecognizer(pan)

        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
        tap.delegate = self
        addGestureRecognizer(tap)
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
    }

    /// Claim only touches on a line, a pill, or the placement handle; the chart
    /// keeps pan/zoom everywhere else.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        guard settings.enabled else { return false }
        if !isPlacementOpen, handleTouchFrame.contains(point) { return true }
        return hitTest(at: point) != nil
    }

    // MARK: - Coordinate mapping

    func yPixel(for price: Double) -> CGFloat? {
        guard let chart else { return nil }
        let point = chart.getTransformer(forAxis: .left).pixelForValues(x: 0, y: price)
        guard point.y.isFinite else { return nil }
        return point.y
    }

    /// Pixel row → price on the underlying.
    func price(at y: CGFloat) -> Double? {
        guard let chart else { return nil }
        let value = chart.getTransformer(forAxis: .left).valueForTouchPoint(CGPoint(x: 0, y: y))
        guard value.y.isFinite else { return nil }
        return Double(value.y)
    }

    // MARK: - Hit testing

    private func hitTest(at point: CGPoint) -> (row: OrderLineRow, pill: OrderLinePill?)? {
        // Nearest row first, so stacked lines resolve to the one under the finger.
        for row in rows.sorted(by: { abs($0.y - point.y) < abs($1.y - point.y) }) {
            for layout in row.pills where layout.touchFrame.contains(point) {
                return (row, layout.pill)
            }
            if abs(point.y - row.y) <= AppOrderLine.lineHitSlop,
               point.x < row.left - AppOrderLine.pillGap {
                return (row, nil)
            }
        }
        return nil
    }

    // MARK: - Gestures

    @objc private func handleTap(_ recognizer: UITapGestureRecognizer) {
        let location = recognizer.location(in: self)
        if !isPlacementOpen, handleTouchFrame.contains(location), let price = effectiveGuidePrice {
            Haptics.impact(.light)
            delegate?.orderLineOverlayDidRequestPlacement(at: price)
            return
        }
        guard let model, let hit = hitTest(at: location) else { return }

        switch hit.row.target {
        case .entry(let contractSymbol):
            guard hit.pill == .close,
                  let entry = entryLines.first(where: { $0.position.symbol == contractSymbol })
            else { return }
            delegate?.orderLineOverlayDidTapFlatten(position: entry.position)

        case .order(let id):
            guard let order = model.order(id: id) else { return }
            switch hit.pill {
            case .close:
                delegate?.orderLineOverlayDidTapCancel(order: order)
            case .orderType:
                delegate?.orderLineOverlayDidToggleOrderType(order: order)
            case .none:
                model.selectedId = model.selectedId == id ? nil : id
                Haptics.selection()
            default:
                break
            }
        }
    }

    @objc private func handlePan(_ recognizer: UIPanGestureRecognizer) {
        // No `guard let model` here: the placement handle can be showing whether
        // or not there are orders to draw, so it must stay draggable when the
        // model is nil. The branches that dereference it guard below.
        let location = recognizer.location(in: self)

        switch recognizer.state {
        case .began:
            // Tested where the finger went down, not where it is now: a pan does
            // not reach `.began` until it has cleared the recognizer's own slop,
            // and a brisk drag can carry the reported location clear of the 44pt
            // target before the first callback arrives — which presents as a
            // handle that simply refuses to be dragged.
            let translation = recognizer.translation(in: self)
            let start = CGPoint(x: location.x - translation.x, y: location.y - translation.y)
            if !isPlacementOpen, handleTouchFrame.contains(start) {
                drag = .guideHandle(startY: start.y, moved: false)
                return
            }
            guard let hit = hitTest(at: location), hit.pill == nil else { return }
            switch hit.row.target {
            case .order(let id):
                guard let model, let order = model.order(id: id), order.isWorking else { return }
                model.selectedId = id
                Haptics.selection()
                drag = .move(orderId: id, price: order.triggerPrice)
            case .entry(let contractSymbol):
                guard settings.bracketDrag,
                      let entry = entryLines.first(where: { $0.position.symbol == contractSymbol })
                else { return }
                drag = .bracket(entry: entry, startY: location.y, price: entry.price, engaged: false)
            }

        case .changed:
            guard let current = drag else { return }
            switch current {
            case .move(let orderId, _):
                guard let price = price(at: location.y) else { return }
                drag = .move(orderId: orderId, price: price)
            case .bracket(let entry, let startY, _, let engaged):
                guard let price = price(at: location.y) else { return }
                // A bracket only materialises once the finger has travelled, so
                // a tap on the entry line never drops a stop on top of it.
                let moved = abs(location.y - startY) >= AppOrderLine.bracketDragThreshold
                if moved, !engaged { Haptics.impact(.light) }
                drag = .bracket(entry: entry, startY: startY, price: price, engaged: engaged || moved)
            case .guideHandle(let startY, let moved):
                // Pin to the pane's edges instead of extrapolating past them: an
                // out-of-range level is one `resolveGuidePrice` dismisses on the
                // next frame, so dragging a little too far would delete the
                // guide out from under the finger holding it.
                let content = chart?.viewPortHandler.contentRect ?? bounds
                let clampedY = Swift.min(content.maxY, Swift.max(content.minY, location.y))
                guard let price = price(at: clampedY) else { return }
                let travelled = moved
                    || abs(location.y - startY) >= AppPlacementGuide.dragThreshold
                if travelled {
                    guidePrice = price
                    drag = .guideHandle(startY: startY, moved: true)
                }
            }
            setNeedsDisplay()

        case .ended:
            let finished = drag
            drag = nil
            setNeedsDisplay()
            switch finished {
            case .move(let orderId, let price):
                guard let model, let order = model.order(id: orderId),
                      order.triggerPrice != price else { return }
                delegate?.orderLineOverlayDidMove(order: order, to: price)
            case .bracket(let entry, _, let price, let engaged):
                guard engaged else { return }
                delegate?.orderLineOverlayDidDragBracket(entry: entry, to: price)
            case .guideHandle:
                break // the level is already where the finger left it
            case .none:
                break
            }

        default:
            drag = nil
            setNeedsDisplay()
        }
    }

    // MARK: - Rendering

    override func draw(_ rect: CGRect) {
        guard settings.enabled, let context = UIGraphicsGetCurrentContext() else {
            rows = []
            handleFrame = .zero
            accessibilityElements = nil
            return
        }
        // Settled before the rows are laid out, because whether a guide is
        // showing decides how much room `rowRightEdge` gives them.
        resolveGuideForFrame()
        var built: [OrderLineRow] = []

        // Entry lines first, so a target or stop resting on one wins the touch —
        // the bracket legs are what actually get adjusted.
        for entry in entryLines {
            guard let y = yPixel(for: entry.price) else { continue }
            let color = entry.position.unrealizedPnl >= 0 ? positiveColor : negativeColor
            let row = layoutRow(
                target: .entry(entry.position.symbol),
                y: y,
                labels: [
                    (.quantity, Format.signedQuantity(entry.position.quantity)),
                    (.pnl, "\(Format.signedPrice(entry.position.unrealizedPnl)) USD"),
                    (.close, "✕"),
                ]
            )
            built.append(row)

            strokeLine(
                to: row.left - 4,
                y: y,
                color: color,
                width: AppOrderLine.strokeEntry,
                dash: [],
                in: context
            )
            for layout in row.pills {
                // The P/L reads as a value, not a control, so it is outlined.
                let filled = layout.pill != .pnl
                renderPill(layout, fill: filled ? color : nil, accent: color, in: context)
            }
        }

        for order in model?.visibleOrders ?? [] {
            guard let y = yPixel(for: order.triggerPrice) else { continue }
            let color = colorFor(order)
            var labels: [(OrderLinePill, String)] = [
                (.quantity, "\(order.quantity)"),
                (.kind, order.kindLabel),
            ]
            if order.isWorking { labels.append((.orderType, order.orderTypeLabel)) }
            labels.append((.close, "✕"))
            let row = layoutRow(target: .order(order.id), y: y, labels: labels)
            built.append(row)

            context.saveGState()
            context.setAlpha(order.isWorking ? 1 : 0.65)
            strokeLine(
                to: row.left - 4,
                y: y,
                color: color,
                width: model?.selectedId == order.id
                    ? AppOrderLine.strokeSelected
                    : AppOrderLine.strokeNormal,
                dash: order.kind == .stop ? AppOrderLine.stopDash : [],
                in: context
            )
            for layout in row.pills {
                // The execution pill changes what happens when this line fires,
                // so it is filled — the eye should land on it.
                let filled = layout.pill != .kind
                renderPill(layout, fill: filled ? color : nil, accent: color, in: context)
            }
            context.restoreGState()
        }

        rows = built
        renderDragPreview(in: context)
        renderPlacementGuide(in: context)
        // Only assistive tech reads these, and draw runs on every pan frame —
        // building them unconditionally would allocate 60x a second for nobody.
        if UIAccessibility.isVoiceOverRunning || UIAccessibility.isSwitchControlRunning {
            rebuildAccessibilityElements()
        }
    }

    private func colorFor(_ order: ChartOrder) -> UIColor {
        if order.status == .failed { return negativeColor }
        switch order.kind {
        case .target: return positiveColor
        case .stop: return negativeColor
        case .limit: return limitColor
        }
    }

    private func renderDragPreview(in context: CGContext) {
        guard case .bracket(let entry, _, let price, let engaged) = drag, engaged,
              let y = yPixel(for: price)
        else { return }
        let kind = bracketKind(
            optionType: entry.contract.optionType,
            quantity: entry.position.quantity,
            entryPrice: entry.price,
            price: price
        )
        let color = kind == .target ? positiveColor : negativeColor
        strokeLine(
            to: bounds.width,
            y: y,
            color: color,
            width: AppOrderLine.strokeEntry,
            dash: AppOrderLine.stopDash,
            in: context
        )
        draw(
            text: "\(kind == .target ? "TARGET" : "STOP") \(Format.price(price))",
            at: CGPoint(x: 8, y: y - 18),
            color: color
        )
    }

    /// Only valid inside `draw(_:)` — it paints into the passed context, which
    /// is the one UIKit made current for the paint pass. Called anywhere else it
    /// silently draws nothing.
    func strokeLine(
        to x: CGFloat,
        y: CGFloat,
        color: UIColor,
        width: CGFloat,
        dash: [CGFloat],
        in context: CGContext
    ) {
        context.setStrokeColor(color.cgColor)
        context.setLineWidth(width)
        context.setLineDash(phase: 0, lengths: dash)
        context.move(to: CGPoint(x: 0, y: y))
        context.addLine(to: CGPoint(x: max(0, x), y: y))
        context.strokePath()
        context.setLineDash(phase: 0, lengths: [])
    }

    // MARK: - Layout

    private var pillFont: UIFont {
        UIFontMetrics(forTextStyle: .caption2)
            .scaledFont(for: .monospacedDigitSystemFont(ofSize: 11, weight: .semibold))
    }

    /// Lays a row out right-to-left from the pane's right edge.
    ///
    /// Touch rects are taller than the pills they cover but never overlap
    /// horizontally — each claims only half the gap to its neighbour, so ✕ and
    /// MID/MKT stay distinct targets no matter how tight the row gets.
    private func layoutRow(
        target: OrderLineRow.Target,
        y: CGFloat,
        labels: [(OrderLinePill, String)]
    ) -> OrderLineRow {
        let font = pillFont
        let widths = labels.map { _, text in
            ceil((text as NSString).size(withAttributes: [.font: font]).width)
                + AppOrderLine.pillPaddingH * 2
        }
        let total = widths.reduce(0, +) + AppOrderLine.pillGap * CGFloat(labels.count - 1)
        let left = rowRightEdge - total
        let touchHeight = max(AppOrderLine.minimumTouchTarget, AppOrderLine.rowHeight)

        var x = left
        var pills: [OrderLinePillLayout] = []
        for (index, entry) in labels.enumerated() {
            let width = widths[index]
            pills.append(
                OrderLinePillLayout(
                    pill: entry.0,
                    label: entry.1,
                    frame: CGRect(
                        x: x,
                        y: y - AppOrderLine.rowHeight / 2,
                        width: width,
                        height: AppOrderLine.rowHeight
                    ),
                    touchFrame: CGRect(
                        x: x - AppOrderLine.pillGap / 2,
                        y: y - touchHeight / 2,
                        width: width + AppOrderLine.pillGap,
                        height: touchHeight
                    )
                )
            )
            x += width + AppOrderLine.pillGap
        }
        return OrderLineRow(target: target, y: y, left: left, pills: pills)
    }

    /// Filled pills read as controls; an outlined one reads as a value.
    private func renderPill(
        _ layout: OrderLinePillLayout,
        fill: UIColor?,
        accent: UIColor,
        in context: CGContext
    ) {
        let path = UIBezierPath(
            roundedRect: layout.frame,
            cornerRadius: AppOrderLine.pillCornerRadius
        )
        if let fill {
            context.setFillColor(fill.cgColor)
            context.addPath(path.cgPath)
            context.fillPath()
        } else {
            context.setStrokeColor(accent.cgColor)
            context.setLineWidth(1)
            context.addPath(path.cgPath)
            context.strokePath()
        }

        let attributes: [NSAttributedString.Key: Any] = [
            .font: pillFont,
            .foregroundColor: fill == nil ? accent : pillTextColor,
        ]
        let text = layout.label as NSString
        let size = text.size(withAttributes: attributes)
        text.draw(
            at: CGPoint(
                x: layout.frame.midX - size.width / 2,
                y: layout.frame.midY - size.height / 2
            ),
            withAttributes: attributes
        )
    }

    /// Like `strokeLine`, only valid inside `draw(_:)`: `NSString.draw(at:)`
    /// paints into the current context and no-ops without one.
    func draw(text: String, at point: CGPoint, color: UIColor) {
        (text as NSString).draw(
            at: point,
            withAttributes: [.font: pillFont, .foregroundColor: color]
        )
    }

    // MARK: - Accessibility

    /// One element per control so VoiceOver users can perceive and act on the
    /// lines; frames are the enlarged touch rects.
    private func rebuildAccessibilityElements() {
        var elements: [UIAccessibilityElement] = []
        for row in rows {
            for layout in row.pills {
                let element = UIAccessibilityElement(accessibilityContainer: self)
                element.accessibilityLabel = accessibilityLabel(for: row.target, pill: layout.pill)
                element.accessibilityTraits = .button
                element.accessibilityFrameInContainerSpace = layout.touchFrame
                elements.append(element)
            }
        }
        if let handle = placementAccessibilityElement() { elements.append(handle) }
        accessibilityElements = elements
    }

    private func accessibilityLabel(for target: OrderLineRow.Target, pill: OrderLinePill) -> String {
        switch target {
        case .entry(let symbol):
            guard let entry = entryLines.first(where: { $0.position.symbol == symbol }) else {
                return "Position"
            }
            switch pill {
            case .close:
                return "Close \(symbol) position"
            case .pnl:
                return "\(symbol) profit and loss \(Format.signedPrice(entry.position.unrealizedPnl))"
            default:
                return "\(symbol) quantity \(entry.position.quantity)"
            }
        case .order(let id):
            guard let order = model?.order(id: id) else { return "Order line" }
            let level = Format.price(order.triggerPrice)
            switch pill {
            case .close:
                return "Cancel \(order.kind.shortLabel) order at \(level)"
            case .orderType:
                let other = order.orderType == .mid ? "market" : "mid"
                return "Execution \(order.orderTypeLabel) at \(level). Double-tap to switch to \(other)"
            case .kind:
                return "\(order.kindLabel) order at \(level)"
            default:
                return "Quantity \(order.quantity)"
            }
        }
    }
}

extension OrderLineOverlayView: UIGestureRecognizerDelegate {
    /// The chart's own pan/pinch must NOT run alongside an order-line drag.
    /// ChartGestureController returns true unconditionally for simultaneous
    /// recognition, so without this a stop would drag while the chart panned
    /// underneath it.
    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool {
        false
    }
}
