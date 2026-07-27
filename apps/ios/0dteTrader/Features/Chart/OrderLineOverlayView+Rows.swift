import UIKit

// How an order-line row is laid out and painted: the line either side of its
// buttons, the buttons themselves, and the text on them. Split out of
// `OrderLineOverlayView.swift` to keep both files under the 700-line limit; the
// gestures, the draw pass that calls these, and the accessibility elements stay
// there.
//
// These members are module-internal rather than `private` for the same reason
// the placement-guide extension's are: `private` on a member is scoped to its
// own file, so the extension in `OrderLineOverlayView.swift` could not see
// them. Nothing outside this type is meant to use them.

extension OrderLineOverlayView {
    // MARK: - Row line

    /// A row's line, in two segments: one to the left of its buttons and one
    /// from their right edge out to the pane's border.
    ///
    /// Two segments rather than one stroke behind the row, because some pills
    /// are outlined rather than filled — the kind pill on an order line, P/L on
    /// an entry line — and a line drawn under those would show through their
    /// interiors and strike through their text. Both halves take the same style,
    /// so a stop stays dashed and a terminal line stays dimmed on either side.
    ///
    /// It runs to the pane's true border rather than stopping at `rightInset`.
    /// The rows clear the options-analytics rail because they are a block of
    /// text it would collide with; a 1.25pt line crossing a sparse profile reads
    /// as a chart line, and stopping short would leave a stub a few points long
    /// that nobody would recognise as the line continuing. The placement guide
    /// already crosses the rail on the same reasoning.
    func strokeRowLine(
        _ row: OrderLineRow,
        style: OrderLineStroke,
        in context: CGContext
    ) {
        strokeLine(
            from: 0,
            to: row.left - AppOrderLine.rowLineGap,
            y: row.y,
            style: style,
            in: context
        )
        strokeLine(
            from: row.right + AppOrderLine.rowLineGap,
            to: bounds.width,
            y: row.y,
            style: style,
            in: context
        )
    }

    /// Only valid inside `draw(_:)` — it paints into the passed context, which
    /// is the one UIKit made current for the paint pass. Called anywhere else it
    /// silently draws nothing.
    func strokeLine(
        from startX: CGFloat,
        to endX: CGFloat,
        y: CGFloat,
        style: OrderLineStroke,
        in context: CGContext
    ) {
        let start = Swift.max(0, startX)
        // A row wide enough to reach the border leaves nothing to draw on its
        // right; stroking it anyway would paint a backwards line.
        guard endX > start else { return }
        context.setStrokeColor(style.color.cgColor)
        context.setLineWidth(style.width)
        context.setLineDash(phase: 0, lengths: style.dash)
        context.move(to: CGPoint(x: start, y: y))
        context.addLine(to: CGPoint(x: endX, y: y))
        context.strokePath()
        context.setLineDash(phase: 0, lengths: [])
    }

    // MARK: - Layout

    var pillFont: UIFont {
        UIFontMetrics(forTextStyle: .caption2)
            .scaledFont(for: .monospacedDigitSystemFont(ofSize: 11, weight: .semibold))
    }

    /// Lays a row out right-to-left from the pane's right edge.
    ///
    /// Touch rects are taller than the pills they cover but never overlap
    /// horizontally — each claims only half the gap to its neighbour, so ✕ and
    /// MID/MKT stay distinct targets no matter how tight the row gets.
    func layoutRow(
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
    func renderPill(
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
}
