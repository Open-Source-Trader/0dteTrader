import DGCharts
import UIKit

// The placement guide's chrome: the dashed level, the `+` handle, the geometry
// the order-line rows must clear, and the handle's assistive-tech element. Split
// out of `OrderLineOverlayView.swift` to keep both files under the 700-line
// limit; the order-line and bracket code stays there.
//
// The members both halves touch — `guidePrice`, `handleFrame`, `strokeLine`,
// `yPixel`, `draw(text:)` going one way, and `renderPlacementGuide`,
// `isPlacementOpen`, `effectiveGuidePrice`, `handleTouchFrame` the other — are
// module-internal rather than `private` for exactly this reason: `private` on a
// member is scoped to its own file, so a cross-file extension cannot see it.
// Nothing outside this type is meant to use them.

/// The `+` handle as assistive tech sees it.
///
/// A bare `UIAccessibilityElement` has no direct-manipulation path, and a swipe
/// on one drives the rotor rather than dragging anything — so without increment
/// and decrement a VoiceOver user is stuck at whatever level `resolveGuidePrice`
/// anchored to and can only ever arm an order there.
final class GuideHandleElement: UIAccessibilityElement {
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

    // MARK: - Guide state

    /// Whether the placement window is open. While it is, it owns the level and
    /// the handle goes inert — one source of truth at any moment.
    var isPlacementOpen: Bool { placementPrice != nil }

    /// The level the guide is drawn at: the open window's, or the handle's own.
    var effectiveGuidePrice: Double? { placementPrice ?? guidePrice }

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

    /// Permanent placement guide: a dashed level with the `+` handle at its
    /// right edge. Suppressed when chart trading is off, and when there is no
    /// chain contract for a new line to trade — `ChartTradingCoordinator`
    /// discards a placement raised in that state, and a control that takes the
    /// tap, spends a haptic and arms nothing is worse than no control.
    ///
    /// Clearing `handleFrame` is what makes the suppression total: hit-testing,
    /// both gesture handlers and the accessibility element all read it, so none
    /// of them can find a handle that was not drawn.
    func renderPlacementGuide(in context: CGContext) {
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

    /// The handle as VoiceOver sees it, or nil when no handle was drawn — with
    /// chart trading off or no contract selected there is nothing to focus.
    func placementAccessibilityElement() -> UIAccessibilityElement? {
        guard !handleFrame.isEmpty, let price = effectiveGuidePrice else { return nil }
        // Reused rather than rebuilt so the element keeps its identity
        // across repaints: `draw(_:)` runs on every pan frame, and handing
        // VoiceOver a fresh element each time would drop focus out from
        // under someone in the middle of adjusting the level.
        let handle: GuideHandleElement = guideHandleElement
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
        return handle
    }
}
