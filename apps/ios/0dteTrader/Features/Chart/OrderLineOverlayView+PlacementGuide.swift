import DGCharts
import UIKit

// The placement guide's chrome: the dashed level, the `+` handle, the geometry
// the order-line rows must clear, and the handle's assistive-tech element. Split
// out of `OrderLineOverlayView.swift` to keep both files under the 700-line
// limit; the order-line and bracket code stays there.
//
// The members these files share — `guidePrice`, `handleFrame` and `yPixel` from
// the main file, `strokeLine` and `draw(text:)` from the rows extension, and
// `renderPlacementGuide`, `isPlacementOpen`, `effectiveGuidePrice`,
// `handleTouchFrame` going the other way — are module-internal rather than
// `private` for exactly this reason: `private` on a member is scoped to its own
// file, so a cross-file extension cannot see it. Nothing outside this type is
// meant to use them.

/// The `+` handle as assistive tech sees it.
///
/// A bare `UIAccessibilityElement` has no direct-manipulation path: a swipe on
/// one drives the rotor rather than dragging anything, and a double-tap on one
/// synthesises a touch wherever it happens to sit. Neither of the two gestures
/// this control is built from — a tap on empty chart space to summon the guide,
/// a drag on the handle to move it — is available that way, so both are offered
/// here explicitly instead.
final class GuideHandleElement: UIAccessibilityElement {
    override func accessibilityActivate() -> Bool {
        overlay?.activateGuideHandle() ?? false
    }

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

extension OrderLineOverlayView {
    // MARK: - Handle geometry

    /// Left edge of the drawn handle, and the single source for where the
    /// handle sits horizontally: `renderPlacementGuide` places the glyph at it,
    /// `handleTouchLeft` grows leftward from it, and `rowRightEdge` backs off
    /// from that. Deriving the same quantity twice from the raw constants would
    /// let the two drift apart silently, and the failure mode is the handle
    /// shadowing ✕ on a live order — the exact collision the band prevents.
    ///
    /// Flush to the pane's right border, `handleMargin` aside. Deliberately not
    /// inset by `rightInset`: the rows clear the options-analytics rail because
    /// they are a column of readable values that the rail would overlap, but the
    /// handle is a single chip the user reaches for at the edge of the screen,
    /// and pushing it inboard of the rail put it somewhere nobody aims.
    var handleLeft: CGFloat {
        bounds.width - AppPlacementGuide.handleMargin - AppPlacementGuide.handleSize
    }

    /// How far the 44pt touch target overhangs the drawn glyph on each side.
    private var handleTouchInset: CGFloat {
        (AppOrderLine.minimumTouchTarget - AppPlacementGuide.handleSize) / 2
    }

    /// Left edge of the handle's touch target — what the rows must clear.
    var handleTouchLeft: CGFloat { handleLeft - handleTouchInset }

    /// Enlarged to the 44pt minimum without moving the drawn glyph.
    var handleTouchFrame: CGRect {
        guard !handleFrame.isEmpty else { return .zero }
        return handleFrame.insetBy(dx: -handleTouchInset, dy: -handleTouchInset)
    }

    /// Right edge the pill rows lay out from.
    ///
    /// Rows must stop short of the placement handle's *touch* target, not
    /// merely its drawn glyph: `point(inside:)` and both gesture handlers check
    /// `handleTouchFrame` before `hitTest`, so any pill whose enlarged target
    /// reaches into that band loses the touch to the handle — and the rightmost
    /// pill is ✕, which cancels a live order. Resolving it the other way round
    /// is not an option: a row sitting at the guide's level would then make the
    /// handle unreachable, and the handle is the only way to drag the guide.
    ///
    /// The band is given up only while a guide is actually showing. It is
    /// summoned and dismissed now rather than always there, and charging every
    /// row for a control that is not on screen costs width for nothing. While it
    /// *is* on screen every row gives it up, not just one that happens to share
    /// the guide's level, so the rows stay aligned with each other and the
    /// collision cannot occur at any y.
    var rowRightEdge: CGFloat {
        Swift.min(
            bounds.width - AppOrderLine.rowRightMargin - rightInset,
            isGuideShowing ? handleTouchLeft - AppOrderLine.pillGap / 2 : .greatestFiniteMagnitude
        )
    }

    // MARK: - Guide state

    /// Whether the placement window is open. While it is, it owns the level and
    /// the handle goes inert — one source of truth at any moment.
    var isPlacementOpen: Bool { placementPrice != nil }

    /// The level the guide is drawn at: the open window's, or the handle's own.
    var effectiveGuidePrice: Double? { placementPrice ?? guidePrice }

    /// Whether a guide is on screen right now. Pure, so `rowRightEdge` can ask
    /// it while the rows are being laid out — `draw(_:)` settles `guidePrice`
    /// before that point precisely so this answer is already this frame's.
    var isGuideShowing: Bool {
        settings.enabled && hasSelectedContract && effectiveGuidePrice != nil
    }

    /// A tap on empty chart space: summons the guide at that level, or dismisses
    /// the one already showing.
    ///
    /// Driven from the chart's own tap recognizer rather than one of this view's
    /// because `point(inside:)` refuses empty space so the chart keeps pan and
    /// zoom. That routing is also what defines "empty": a tap that reached the
    /// chart at all is one no order line, pill, handle or drawing claimed.
    func toggleGuide(at point: CGPoint) {
        guard settings.enabled, hasSelectedContract, !isPlacementOpen else { return }
        if guidePrice != nil {
            guidePrice = nil
        } else {
            guard let price = price(at: point.y) else { return }
            guidePrice = price
        }
        Haptics.impact(.light)
        setNeedsDisplay()
    }

    /// Assistive tech's route through the handle, which has no drag and no tap
    /// on empty space: summons the guide into the middle of the pane when none
    /// is showing, and otherwise arms the card at the level it is on — the same
    /// two steps a tap on the chart and a tap on the `+` give everyone else.
    func activateGuideHandle() -> Bool {
        guard settings.enabled, hasSelectedContract, !isPlacementOpen else { return false }
        if let price = effectiveGuidePrice {
            Haptics.impact(.light)
            delegate?.orderLineOverlayDidRequestPlacement(at: price)
            return true
        }
        let visibleRect = chart?.viewPortHandler.contentRect ?? bounds
        guard let price = price(at: visibleRect.midY) else { return false }
        guidePrice = price
        Haptics.impact(.light)
        setNeedsDisplay()
        return true
    }

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

    // MARK: - Rendering

    /// Settles the guide's level for this paint pass.
    ///
    /// Split out of the render so it can run before the rows are laid out: the
    /// band they give up to the handle depends on whether one is showing, and
    /// asking that question against the previous frame's answer would leave the
    /// rows a frame behind the control they are avoiding.
    ///
    /// The guide is suppressed outright when there is no chain contract for a
    /// new line to trade — `ChartTradingCoordinator` discards a placement raised
    /// in that state, and a control that takes the tap, spends a haptic and arms
    /// nothing is worse than no control.
    func resolveGuideForFrame() {
        guard hasSelectedContract else {
            guidePrice = nil
            return
        }
        // Tracked while the card is open too, not just when it is closed. The
        // card's level is the handle's rounded to a tick by the coordinator, so
        // without this the guide would un-round itself on dismiss and sit a
        // fraction off the level the order was actually armed at — and since the
        // card's Level field can move the guide, it is also what keeps a typed
        // price from being discarded the moment the card closes.
        if isPlacementOpen {
            guidePrice = placementPrice
            return
        }
        let visibleRect = chart?.viewPortHandler.contentRect ?? bounds
        guidePrice = resolveGuidePrice(
            current: guidePrice,
            min: price(at: visibleRect.maxY) ?? .nan,
            max: price(at: visibleRect.minY) ?? .nan
        )
    }

    /// The placement guide: a dashed level with the `+` handle flush to the
    /// pane's right edge, drawn only once a tap on empty chart space has
    /// summoned one.
    ///
    /// Clearing `handleFrame` is what makes a dismissal total: hit-testing, both
    /// gesture handlers and the accessibility element all read it, so none of
    /// them can find a handle that was not drawn.
    func renderPlacementGuide(in context: CGContext) {
        guard isGuideShowing, let resolved = effectiveGuidePrice,
              let y = yPixel(for: resolved)
        else {
            handleFrame = .zero
            return
        }

        let size = AppPlacementGuide.handleSize
        let frame = CGRect(x: handleLeft, y: y - size / 2, width: size, height: size)
        handleFrame = frame

        // Stroked up to the handle rather than stopping short of it, matching
        // the desktop twin: the dash and the chip read as one control.
        strokeLine(
            from: 0,
            to: handleLeft,
            y: y,
            style: OrderLineStroke(color: .hudAxisLabel, width: 1, dash: AppPlacementGuide.dash),
            in: context
        )
        // The level only needs calling out while it is moving; the rest of the
        // time the price axis already says where the line is.
        if isDraggingGuide {
            draw(text: Format.price(resolved), at: CGPoint(x: 8, y: y - 18), color: .hudAxisLabel)
        }
        renderHandle(frame, in: context)
    }

    /// Chamfered HUD chip with a `+` glyph — the same silhouette as
    /// `HudPanelShape` at chip scale, drawn in CoreGraphics because this view
    /// paints itself.
    ///
    /// Dimmed while the placement window is open. The caller has already
    /// decided there is a handle to draw at all; what this dim covers is the
    /// narrower case where one exists but refuses touches, because the open
    /// card owns the level — at full opacity it would advertise an action it
    /// will not perform.
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

    // MARK: - Accessibility

    /// The handle as VoiceOver sees it, or nil when chart trading is off or
    /// there is no contract for a new line to trade — nothing to focus then.
    ///
    /// Present even with no guide showing, parked where the handle would appear.
    /// Summoning one is a tap on empty chart space, which is not a gesture
    /// VoiceOver can make, so without a dormant element to activate there would
    /// be no assistive route to chart order placement at all.
    func placementAccessibilityElement() -> UIAccessibilityElement? {
        guard settings.enabled, hasSelectedContract else { return nil }
        // Reused rather than rebuilt so the element keeps its identity
        // across repaints: `draw(_:)` runs on every pan frame, and handing
        // VoiceOver a fresh element each time would drop focus out from
        // under someone in the middle of adjusting the level.
        let handle: GuideHandleElement = guideHandleElement
        if let price = effectiveGuidePrice, !handleFrame.isEmpty {
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
        } else {
            handle.accessibilityLabel = "Show the order placement guide"
            handle.accessibilityValue = nil
            handle.accessibilityHint = nil
            handle.accessibilityTraits = .button
            handle.accessibilityFrameInContainerSpace = dormantHandleTouchFrame
        }
        return handle
    }

    /// Where the dormant handle sits: the pane's right edge, vertically centred,
    /// at the same 44pt target the drawn one carries.
    private var dormantHandleTouchFrame: CGRect {
        let visibleRect = chart?.viewPortHandler.contentRect ?? bounds
        let size = AppPlacementGuide.handleSize
        return CGRect(x: handleLeft, y: visibleRect.midY - size / 2, width: size, height: size)
            .insetBy(dx: -handleTouchInset, dy: -handleTouchInset)
    }
}
