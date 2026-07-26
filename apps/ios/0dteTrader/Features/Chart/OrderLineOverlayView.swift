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

/// The `+` handle as assistive tech sees it.
///
/// A bare `UIAccessibilityElement` has no direct-manipulation path, and a swipe
/// on one drives the rotor rather than dragging anything — so without increment
/// and decrement a VoiceOver user is stuck at whatever level `resolveGuidePrice`
/// anchored to and can only ever arm an order there.
private final class GuideHandleElement: UIAccessibilityElement {
    override func accessibilityIncrement() {
        overlay?.stepGuidePrice(by: AppPlacementGuide.adjustmentStep)
    }

    override func accessibilityDecrement() {
        overlay?.stepGuidePrice(by: -AppPlacementGuide.adjustmentStep)
    }

    /// Reached through the container UIKit already holds weakly, so the view's
    /// `accessibilityElements` array does not retain the view back.
    private var overlay: OrderLineOverlayView? {
        accessibilityContainer as? OrderLineOverlayView
    }
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

    /// Last traded price — where the guide parks when it has nowhere else to be.
    var lastPrice: Double? {
        didSet {
            guard lastPrice != oldValue else { return }
            setNeedsDisplay()
        }
    }

    /// The guide's level. Owned here because dragging it is a UIKit gesture;
    /// SwiftUI only hears about it when the `+` is tapped.
    ///
    /// Advanced by `draw(_:)` as well as by the gesture handlers — the paint
    /// pass is what re-anchors it through `resolveGuidePrice` — so the ordering
    /// of drag and paint is load-bearing. Safe because it has no `didSet` and
    /// nothing in the paint path can re-enter drawing.
    private var guidePrice: Double?
    /// The handle as last drawn, for hit-testing.
    private var handleFrame: CGRect = .zero
    /// One long-lived element for the handle, so VoiceOver focus survives the
    /// repaints that rebuild everything else.
    private lazy var guideHandleElement = GuideHandleElement(accessibilityContainer: self)

    /// Nudges the guide by one tick. VoiceOver's increment/decrement path, and
    /// the only way to move the guide without a pointer.
    fileprivate func stepGuidePrice(by delta: Double) {
        // The card owns the level while it is open; the handle is inert then,
        // and adjusting it would fight the price the card is armed at.
        guard !isPlacementOpen, let current = effectiveGuidePrice else { return }
        // Re-rounded rather than accumulated, so repeated steps cannot drift off
        // the tick through floating-point error.
        guidePrice = ((current + delta) * 100).rounded() / 100
        setNeedsDisplay()
    }

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
    /// armed at rather than reverting. The guide itself is permanent either way.
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

    private let limitColor: UIColor = .appAccent
    private let positiveColor: UIColor = .appPnlPositive
    private let negativeColor: UIColor = .appPnlNegative
    private let pillTextColor = UIColor.black

    override init(frame: CGRect) {
        super.init(frame: frame)
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

    /// Left edge of the drawn handle, and the single source for where the
    /// handle sits horizontally: `renderPlacementGuide` places the glyph at it,
    /// `handleTouchLeft` grows leftward from it, and `rowRightEdge` backs off
    /// from that. Deriving the same quantity twice from the raw constants would
    /// let the two drift apart silently, and the failure mode is the handle
    /// shadowing ✕ on a live order — the exact collision the band prevents.
    var handleLeft: CGFloat {
        bounds.width - rightInset - AppPlacementGuide.handleMargin - AppPlacementGuide.handleSize
    }

    /// How far the 44pt touch target overhangs the drawn glyph on each side.
    private var handleTouchInset: CGFloat {
        (AppOrderLine.minimumTouchTarget - AppPlacementGuide.handleSize) / 2
    }

    /// Left edge of the handle's touch target — what the rows must clear.
    var handleTouchLeft: CGFloat { handleLeft - handleTouchInset }

    /// Enlarged to the 44pt minimum without moving the drawn glyph.
    private var handleTouchFrame: CGRect {
        guard !handleFrame.isEmpty else { return .zero }
        return handleFrame.insetBy(dx: -handleTouchInset, dy: -handleTouchInset)
    }

    // MARK: - Coordinate mapping

    private func yPixel(for price: Double) -> CGFloat? {
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

    /// Whether the placement window is open. While it is, it owns the level and
    /// the handle goes inert — one source of truth at any moment.
    private var isPlacementOpen: Bool { placementPrice != nil }

    /// The level the guide is drawn at: the open window's, or the handle's own.
    private var effectiveGuidePrice: Double? { placementPrice ?? guidePrice }

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
        // No `guard let model` here: the placement handle is chrome that exists
        // whether or not there are orders to draw, so it must stay draggable
        // when the model is nil. The branches that dereference it guard below.
        let location = recognizer.location(in: self)

        switch recognizer.state {
        case .began:
            if !isPlacementOpen, handleTouchFrame.contains(location) {
                drag = .guideHandle(startY: location.y, moved: false)
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
                // out-of-range level makes `resolveGuidePrice` re-anchor to the
                // last price on the next frame, which reads as the guide
                // teleporting mid-drag.
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

    /// Permanent placement guide: a dashed level with the `+` handle at its
    /// right edge. Suppressed when chart trading is off, and when there is no
    /// chain contract for a new line to trade — `ChartTradingCoordinator`
    /// discards a placement raised in that state, and a control that takes the
    /// tap, spends a haptic and arms nothing is worse than no control.
    ///
    /// Clearing `handleFrame` is what makes the suppression total: hit-testing,
    /// both gesture handlers and the accessibility element all read it, so none
    /// of them can find a handle that was not drawn.
    private func renderPlacementGuide(in context: CGContext) {
        guard hasSelectedContract else {
            handleFrame = .zero
            return
        }
        let visibleRect = chart?.viewPortHandler.contentRect ?? bounds
        let resolved = isPlacementOpen
            // While the card is open it owns the level, so the guide does not
            // re-anchor away from the price the card is armed at.
            ? placementPrice
            : resolveGuidePrice(
                current: guidePrice,
                lastPrice: lastPrice,
                min: price(at: visibleRect.maxY) ?? .nan,
                max: price(at: visibleRect.minY) ?? .nan
            )
        // Tracked in both states, not just when the card is closed. The card's
        // level is the handle's rounded to a tick by the coordinator, so
        // without this the guide would un-round itself on dismiss and sit a
        // fraction off the level the order was actually armed at — and now that
        // the card's Level field can move the guide, it is also what keeps a
        // typed price from being discarded the moment the card closes.
        guidePrice = resolved

        guard let resolved, let y = yPixel(for: resolved) else {
            handleFrame = .zero
            return
        }

        let size = AppPlacementGuide.handleSize
        let frame = CGRect(x: handleLeft, y: y - size / 2, width: size, height: size)
        handleFrame = frame

        // Stroked up to the handle rather than stopping short of it, matching
        // the desktop twin: the dash and the chip read as one control.
        strokeLine(
            to: handleLeft,
            y: y,
            color: .hudAxisLabel,
            width: 1,
            dash: AppPlacementGuide.dash,
            in: context
        )
        // The level only needs calling out while it is moving; the rest of the
        // time the price axis already says where the line is.
        if case .guideHandle(_, true) = drag {
            draw(text: Format.price(resolved), at: CGPoint(x: 8, y: y - 18), color: .hudAxisLabel)
        }
        renderHandle(frame, in: context)
    }

    /// Chamfered HUD chip with a `+` glyph — the same silhouette as
    /// `HudPanelShape` at chip scale, drawn in CoreGraphics because this view
    /// paints itself.
    ///
    /// Dimmed while the placement window is open: it is drawn unconditionally
    /// but hit-tested only when the window is closed, and at full opacity it
    /// would advertise an action it will not perform.
    private func renderHandle(_ frame: CGRect, in context: CGContext) {
        context.saveGState()
        if isPlacementOpen { context.setAlpha(CGFloat(AppOpacity.disabled)) }
        defer { context.restoreGState() }

        let c = AppPlacementGuide.handleChamfer
        let path = CGMutablePath()
        path.move(to: CGPoint(x: frame.minX + c, y: frame.minY))
        path.addLine(to: CGPoint(x: frame.maxX - c, y: frame.minY))
        path.addLine(to: CGPoint(x: frame.maxX, y: frame.minY + c))
        path.addLine(to: CGPoint(x: frame.maxX, y: frame.maxY - c))
        path.addLine(to: CGPoint(x: frame.maxX - c, y: frame.maxY))
        path.addLine(to: CGPoint(x: frame.minX + c, y: frame.maxY))
        path.addLine(to: CGPoint(x: frame.minX, y: frame.maxY - c))
        path.addLine(to: CGPoint(x: frame.minX, y: frame.minY + c))
        path.closeSubpath()

        context.setFillColor(UIColor.black.withAlphaComponent(0.85).cgColor)
        context.addPath(path)
        context.fillPath()
        context.setStrokeColor(UIColor.appAccent.cgColor)
        context.setLineWidth(1)
        context.addPath(path)
        context.strokePath()

        let arm = frame.width * 0.28
        context.setStrokeColor(UIColor.appAccent.cgColor)
        context.setLineWidth(1.5)
        context.move(to: CGPoint(x: frame.midX - arm, y: frame.midY))
        context.addLine(to: CGPoint(x: frame.midX + arm, y: frame.midY))
        context.move(to: CGPoint(x: frame.midX, y: frame.midY - arm))
        context.addLine(to: CGPoint(x: frame.midX, y: frame.midY + arm))
        context.strokePath()
    }

    private func strokeLine(
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

    /// Right edge the pill rows lay out from.
    ///
    /// Rows must stop short of the placement handle's *touch* target, not
    /// merely its drawn glyph: `point(inside:)` and both gesture handlers check
    /// `handleTouchFrame` before `hitTest`, so any pill whose enlarged target
    /// reaches into that band loses the touch to the handle — and the rightmost
    /// pill is ✕, which cancels a live order. Resolving it the other way round
    /// is not an option: a row sitting at the guide's level would then make the
    /// handle unreachable, and the handle is the only way to move the guide.
    ///
    /// Every row gives up the band, not just one that happens to share the
    /// guide's level, so the rows stay aligned with each other and the
    /// collision cannot occur at any y. Reserving it per-row would buy back a
    /// few points for rows far from the guide at the cost of a layout that
    /// shifts as the guide is dragged past them.
    var rowRightEdge: CGFloat {
        Swift.min(
            bounds.width - AppOrderLine.rowRightMargin - rightInset,
            handleTouchLeft - AppOrderLine.pillGap / 2
        )
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

    private func draw(text: String, at point: CGPoint, color: UIColor) {
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
        if !handleFrame.isEmpty, let price = effectiveGuidePrice {
            // Reused rather than rebuilt so the element keeps its identity
            // across repaints: `draw(_:)` runs on every pan frame, and handing
            // VoiceOver a fresh element each time would drop focus out from
            // under someone in the middle of adjusting the level.
            let handle = guideHandleElement
            handle.accessibilityLabel = "Place an order"
            handle.accessibilityValue = Format.price(price)
            handle.accessibilityHint = "Swipe up or down to change the level"
            // Adjustable, not merely a button: the handle is the only way to
            // move the guide, and dragging it is not a gesture VoiceOver can
            // make. While the card owns the level the handle refuses touches,
            // so it must not advertise controls it will not honour.
            handle.accessibilityTraits = isPlacementOpen
                ? [.button, .adjustable, .notEnabled]
                : [.button, .adjustable]
            handle.accessibilityFrameInContainerSpace = handleTouchFrame
            elements.append(handle)
        }
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
