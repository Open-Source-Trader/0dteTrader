import SwiftUI

/// Lifts one fixed-height pane clear of the software keyboard, without letting
/// the keyboard anywhere near the geometry that sized the screen.
///
/// SwiftUI's automatic avoidance is the wrong tool wherever a screen measures
/// itself off a `GeometryReader`: it does not push the focused field up, it
/// subtracts the keyboard's height from the bottom safe area. The reader then
/// reports a screen ~300pt shorter and *every* pane sized off it recomputes —
/// on the trade screen the header runs off the top, the chart collapses to a
/// stub and the panel smears into it. That is a full-layout collapse, and no
/// amount of re-enabling avoidance for "just this one field" avoids it, because
/// the reader's height is the lever either way.
///
/// So the screen opts out of avoidance permanently and the single pane with a
/// field under the keys moves on its own, by a drawing offset. An offset is
/// applied after layout: the height feeding the reader never changes, the chart
/// and the header never move, and the movement is bounded by `maxLift`.
struct KeyboardLift: ViewModifier {
    /// How far above the pane's own bottom edge the thing that has to stay
    /// visible sits — nil while nothing in this pane owns the keyboard, and
    /// nothing lifts for a keyboard raised elsewhere on the screen.
    ///
    /// The pane rises far enough to bring *that* clear of the keys and not one
    /// point further. The difference matters more than it sounds: lifting the
    /// whole panel clear would carry SELL/BUY up out from behind the keyboard
    /// and park them beside its Done bar, which is not a row to put under a
    /// typing thumb.
    let clearance: CGFloat?
    /// Ceiling on the movement: the room above the pane. Without it a tall
    /// keyboard on a short screen would drive the pane off the top.
    let maxLift: CGFloat

    /// Top edge of the docked keyboard in window coordinates; nil while down.
    @State private var keyboardTop: CGFloat?
    /// The pane's resting bottom edge, in the same coordinates.
    @State private var paneBottom: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var lift: CGFloat {
        guard let clearance, let keyboardTop else { return 0 }
        return min(max(paneBottom - clearance - keyboardTop, 0), max(maxLift, 0))
    }

    func body(content: Content) -> some View {
        content
            .background {
                GeometryReader { proxy in
                    let bottom = proxy.frame(in: .global).maxY
                    Color.clear
                        .onChange(of: bottom, initial: true) { _, newBottom in
                            // Only ever read at rest. Once the pane is lifted
                            // this reading is the lift's own output, and a lift
                            // computed from it would chase itself up the screen.
                            if lift == 0 { paneBottom = newBottom }
                        }
                }
            }
            .offset(y: -lift)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: lift)
            .onReceive(
                NotificationCenter.default.publisher(
                    for: UIResponder.keyboardWillChangeFrameNotification
                )
            ) { note in
                guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect
                else { return }
                keyboardTop = frame.minY
            }
            // `willChangeFrame` also fires on the way down, reporting a
            // full-height keyboard parked just off-screen, so the state has to
            // be cleared by the notification that actually means "gone".
            .onReceive(
                NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)
            ) { _ in
                keyboardTop = nil
            }
    }
}

extension View {
    /// See `KeyboardLift`.
    func keyboardLift(clearance: CGFloat?, maxLift: CGFloat) -> some View {
        modifier(KeyboardLift(clearance: clearance, maxLift: maxLift))
    }
}
