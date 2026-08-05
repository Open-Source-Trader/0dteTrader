import SwiftUI

/// Presents `PositionsPanelView` as a trailing-edge drawer over the trade
/// panel. A ViewModifier in the `OrderConfirmPresentation` mould: the screen
/// applies it to the panel area and this owns the open/drag state, the
/// chevron affordance, the scrim, and the dismiss gestures (scrim tap, drag
/// back out to the right).
struct PositionsPanelPresentation: ViewModifier {
    @ObservedObject var tradeViewModel: TradeViewModel
    @ObservedObject var chartOrders: ChartOrdersModel
    var tradingLocked: Bool = false

    @State private var isOpen = false
    /// Live rightward drag translation while dismissing, so the drawer
    /// follows the finger.
    @State private var dragOffset: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let panelWidth: CGFloat = 300
    /// Horizontal travel that commits an open (leftward) or dismiss
    /// (rightward) drag.
    private static let dragThreshold: CGFloat = 60

    func body(content: Content) -> some View {
        content
            // Swipe left anywhere on the panel opens the drawer. Simultaneous,
            // so the panel's buttons, menus, and horizontal strips keep their
            // own gestures; this one only acts on a decisive leftward drag.
            .simultaneousGesture(openGesture)
            .overlay(alignment: .trailing) {
                if !isOpen { chevron }
            }
            .overlay {
                if isOpen { scrim }
            }
            .overlay(alignment: .trailing) {
                if isOpen { drawer }
            }
    }

    // MARK: - Pieces

    /// Persistent affordance on the trailing edge — the drawer is otherwise
    /// undiscoverable.
    private var chevron: some View {
        Button {
            Haptics.selection()
            open()
        } label: {
            Image(systemName: "chevron.left")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.appAccent)
                .frame(width: 18, height: 56)
                .background(
                    Color.appSurface,
                    in: UnevenRoundedRectangle(topLeadingRadius: 8, bottomLeadingRadius: 8)
                )
                .overlay(
                    UnevenRoundedRectangle(topLeadingRadius: 8, bottomLeadingRadius: 8)
                        .strokeBorder(Color.hudStrokeDim.opacity(0.6), lineWidth: 1)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(AppPressStyle())
        .accessibilityLabel("Open positions panel")
    }

    private var scrim: some View {
        Color.black.opacity(0.45)
            .contentShape(Rectangle())
            .onTapGesture { dismiss() }
            .transition(.opacity)
            .accessibilityLabel("Dismiss positions panel")
            .accessibilityAddTraits(.isButton)
    }

    private var drawer: some View {
        PositionsPanelView(
            tradeViewModel: tradeViewModel,
            chartOrders: chartOrders,
            tradingLocked: tradingLocked,
            onDismiss: { dismiss() }
        )
        .frame(width: Self.panelWidth)
        .frame(maxHeight: .infinity)
        .offset(x: max(0, dragOffset))
        .transition(reduceMotion ? .opacity : .move(edge: .trailing))
        // Simultaneous so the drawer's vertical scroll keeps working; only a
        // decisive rightward drag moves the drawer out.
        .simultaneousGesture(dismissGesture)
        .accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape) { dismiss() }
    }

    // MARK: - Gestures

    private var openGesture: some Gesture {
        DragGesture(minimumDistance: 25)
            .onEnded { value in
                guard !isOpen,
                      value.translation.width < -Self.dragThreshold,
                      abs(value.translation.width) > abs(value.translation.height)
                else { return }
                Haptics.selection()
                open()
            }
    }

    private var dismissGesture: some Gesture {
        DragGesture(minimumDistance: 15)
            .onChanged { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                dragOffset = max(0, value.translation.width)
            }
            .onEnded { value in
                if value.translation.width > Self.dragThreshold {
                    dismiss()
                } else {
                    withAnimation(panelAnimation) { dragOffset = 0 }
                }
            }
    }

    // MARK: - State

    private var panelAnimation: Animation? {
        reduceMotion ? nil : .snappy(duration: 0.25, extraBounce: 0)
    }

    private func open() {
        dragOffset = 0
        withAnimation(panelAnimation) { isOpen = true }
    }

    private func dismiss() {
        withAnimation(panelAnimation) { isOpen = false }
        dragOffset = 0
    }
}
