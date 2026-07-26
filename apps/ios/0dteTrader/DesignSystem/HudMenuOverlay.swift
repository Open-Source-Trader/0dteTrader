import SwiftUI

/// The screen's single anchored-popup slot, and the plumbing that lets a chip
/// anywhere in the tree fill it.
///
/// Popups used to be `.popover`s. A popover's container is UIKit's: its rounded
/// rectangle, its arrow, its shadow and — the part that finally forced this —
/// its placement are not settable, so a popup could not slide down out of the
/// chip that opened it, and could not sit against the screen edge that chip
/// lives on. Drawn here instead, over the whole screen, with the HUD's own
/// panel silhouette and nothing of iOS's.
///
/// The reason it is a screen-level slot rather than an `.overlay` on each chip
/// is that every one of these chips sits inside something that clips: the chart
/// pane is `clipShape`d to its chamfer and the trade panel is `.clipped()`. An
/// overlay is clipped by its ancestors; this is not, because it is declared
/// above all of them.
///
/// Presenting from here also hardens the fix that made these popups stop being
/// `Menu`s: the content is built once, at the moment of presentation, and
/// stored. No later chain tick can reach an open popup at all — not the rows,
/// not the scroll offset, not the touch in flight.
@MainActor
final class HudMenuController: ObservableObject {
    struct Presentation: Identifiable, Equatable {
        let id: String
        /// The trigger's drawn box in the window's coordinate space.
        let anchor: CGRect
        /// Which screen edge the popup lines up with — the one its trigger
        /// lives on, so the popup reads as having come out of the chip.
        let edge: HorizontalEdge
        let content: AnyView
        /// What a tap on the scrim means for *this* popup. Nil is the pickers'
        /// answer — nothing, just close. A popup whose state lives outside the
        /// controller sets it, and owns the close itself; see `userDismiss`.
        let onUserDismiss: (() -> Void)?

        static func == (lhs: Presentation, rhs: Presentation) -> Bool {
            lhs.id == rhs.id && lhs.anchor == rhs.anchor && lhs.edge == rhs.edge
        }
    }

    @Published private(set) var presentation: Presentation?

    /// Opens `id`'s popup, or closes it if it is the one already open — a
    /// second tap on a trigger is a request to put the popup away.
    func present(
        id: String,
        anchor: CGRect,
        edge: HorizontalEdge,
        onUserDismiss: (() -> Void)? = nil,
        content: (@escaping () -> Void) -> AnyView
    ) {
        guard presentation?.id != id else {
            dismiss()
            return
        }
        let body = content { [weak self] in self?.dismiss() }
        presentation = Presentation(
            id: id,
            anchor: anchor,
            edge: edge,
            content: body,
            onUserDismiss: onUserDismiss
        )
    }

    /// Closes the popup the way the *user* closes it: the scrim, or VoiceOver's
    /// escape action. Distinct from `dismiss()`, which is the popup's own
    /// content deciding it is finished.
    ///
    /// A popup that supplied `onUserDismiss` is not closed here. It is closed by
    /// whatever that closure does to the state driving the presentation, which
    /// is the only way a popup can refuse to go away — the order confirmation
    /// mid-submission being the case that needs it.
    func userDismiss() {
        guard let onUserDismiss = presentation?.onUserDismiss else {
            dismiss()
            return
        }
        onUserDismiss()
    }

    func dismiss() {
        presentation = nil
    }
}

/// The drawn box a popup hangs from.
///
/// Not the trigger button's frame: the chart chips wear a 44pt touch target
/// around a 22pt chip, so a popup measured off the button would open 22pt below
/// where the chip visibly ends. The chrome helpers publish the box they draw
/// and the trigger reads that instead.
struct HudMenuAnchorKey: PreferenceKey {
    static let defaultValue: CGRect? = nil

    static func reduce(value: inout CGRect?, nextValue: () -> CGRect?) {
        value = nextValue() ?? value
    }
}

extension View {
    /// Publishes this view's frame as the box a popup opened from here hangs
    /// from. Applied by the chip chrome, so every trigger gets it for free.
    func hudMenuAnchorSource() -> some View {
        background {
            GeometryReader { proxy in
                Color.clear.preference(key: HudMenuAnchorKey.self, value: proxy.frame(in: .global))
            }
        }
    }

    /// Hosts the screen's popup slot. One per screen, declared last so the
    /// popups draw over everything and nothing clips them.
    func hudMenuHost(_ controller: HudMenuController) -> some View {
        overlay {
            // Two readers, deliberately. This one still respects the safe area,
            // so it can report the strip the home indicator owns; the layer's
            // own reader ignores it, because the anchors arrive in window
            // coordinates and the popup has to be placed in the same space. A
            // reader cannot do both: once it ignores the safe area it reports
            // the insets as zero, and a popup sized off those runs off the
            // bottom of the screen.
            GeometryReader { proxy in
                HudMenuLayer(controller: controller, safeInsets: proxy.safeAreaInsets)
            }
        }
        .environmentObject(controller)
    }
}

/// A chip whose popup is drawn by the screen's `HudMenuLayer`.
struct HudMenuTrigger<Label: View>: View {
    /// Stable across body passes: it is what tells a second tap on this chip
    /// from a first tap on another one.
    let id: String
    let edge: HorizontalEdge
    /// Handed the closure that puts the popup away, so a row can select and
    /// close in one gesture.
    let content: (@escaping () -> Void) -> AnyView
    @ViewBuilder let label: () -> Label

    @EnvironmentObject private var controller: HudMenuController
    @State private var anchor: CGRect = .zero

    var body: some View {
        Button {
            Haptics.selection()
            controller.present(id: id, anchor: anchor, edge: edge, content: content)
        } label: {
            label()
        }
        .onPreferenceChange(HudMenuAnchorKey.self) { rect in
            if let rect { anchor = rect }
        }
    }
}

/// Draws whatever popup is open, positioned off its trigger and against its
/// screen edge, over a tap-away scrim.
private struct HudMenuLayer: View {
    @ObservedObject var controller: HudMenuController
    /// Measured where the safe area is still visible; see `hudMenuHost`.
    let safeInsets: EdgeInsets
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Gap between the chip's bottom border and the popup's top.
    private static let gap: CGFloat = 6
    /// The inset the chart's chip row already keeps off the pane's borders, so
    /// an edge-aligned popup lines up with the chip column rather than with
    /// the glass.
    private static let screenInset = AppSpacing.sm
    /// Floor for either direction, so a popup pinned between a chip and an edge
    /// still shows something.
    private static let minimumHeight: CGFloat = 120

    var body: some View {
        GeometryReader { proxy in
            if let presentation = controller.presentation {
                // The trigger reports its box in `.global`; this reader's own
                // frame says where `.global` starts from here, so subtracting it
                // puts the anchor in the layer's own coordinates. Doing the
                // arithmetic rather than assuming the two spaces coincide is
                // what makes the placement independent of how the safe area
                // happens to be applied above us.
                let origin = proxy.frame(in: .global).origin
                let anchor = presentation.anchor.offsetBy(dx: -origin.x, dy: -origin.y)
                let below = proxy.size.height - anchor.maxY - Self.gap - safeInsets.bottom
                let above = anchor.minY - Self.gap - safeInsets.top
                // Whichever side has more room, rather than a preference with
                // a threshold. The chart's chips have the whole pane below them
                // and nothing above; the panel's have the reverse, and a strike
                // list given the last 200pt of the screen shows five rows.
                let opensDown = below >= above
                ZStack(alignment: .topLeading) {
                    // Tap-away dismiss, the same near-invisible scrim the
                    // placement card uses: a dropdown must never be the thing
                    // standing between you and your chart.
                    Color.black.opacity(0.001)
                        .contentShape(Rectangle())
                        .onTapGesture { controller.userDismiss() }
                        .accessibilityHidden(true)

                    presentation.content
                        // Aligned, not just capped. This frame is a ceiling on
                        // how much of the screen a popup may take, so it is
                        // usually taller than the list inside it — and a bare
                        // `maxHeight` centres its child, which floated the
                        // popup into the middle of the chart instead of hanging
                        // it off the chip.
                        .frame(
                            maxHeight: max(
                                (opensDown ? below : above) - Self.screenInset,
                                Self.minimumHeight
                            ),
                            alignment: opensDown ? .top : .bottom
                        )
                        // `.isModal` keeps VoiceOver inside the popup instead of
                        // letting it walk on to the chart underneath; the escape
                        // action is how it gets back out, since the scrim it
                        // would otherwise tap is hidden from it.
                        .accessibilityAddTraits(.isModal)
                        .accessibilityAction(.escape) { controller.userDismiss() }
                        .transition(
                            reduceMotion
                                ? .opacity
                                : .modifier(
                                    active: HudMenuDrop(progress: 0, opensDown: opensDown),
                                    identity: HudMenuDrop(progress: 1, opensDown: opensDown)
                                )
                        )
                        .frame(
                            maxWidth: .infinity,
                            maxHeight: .infinity,
                            alignment: alignment(presentation.edge, opensDown: opensDown)
                        )
                        .padding(
                            opensDown ? .top : .bottom,
                            opensDown
                                ? anchor.maxY + Self.gap
                                : proxy.size.height - anchor.minY + Self.gap
                        )
                        .padding(.horizontal, Self.screenInset)
                }
            }
        }
        .ignoresSafeArea()
        .animation(
            reduceMotion ? AppMotion.quick : AppMotion.standard,
            value: controller.presentation
        )
    }

    private func alignment(_ edge: HorizontalEdge, opensDown: Bool) -> Alignment {
        switch (edge, opensDown) {
        case (.leading, true): return .topLeading
        case (.leading, false): return .bottomLeading
        case (.trailing, true): return .topTrailing
        case (.trailing, false): return .bottomTrailing
        }
    }
}

/// The popup's entrance: a short drop out of the chip rather than a fade in
/// place, anchored to whichever edge it opened from.
///
/// Deliberately not `.move(edge: .top)`, which travels the popup's own height —
/// on a nine-row strike list that is a 360pt swoop across the chart.
private struct HudMenuDrop: ViewModifier {
    let progress: Double
    let opensDown: Bool

    func body(content: Content) -> some View {
        content
            .opacity(progress)
            .scaleEffect(
                x: 1,
                y: 0.94 + 0.06 * progress,
                anchor: opensDown ? .top : .bottom
            )
            .offset(y: (opensDown ? -10 : 10) * (1 - progress))
    }
}
