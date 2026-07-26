import SwiftUI
import UIKit

/// Putting the keyboard away without naming the field that holds it.
enum Keyboard {
    /// Resigns whatever is first responder.
    ///
    /// A resign rather than clearing a `@FocusState` because the callers sit
    /// above every field they serve and cannot reach any of them by name. The
    /// fields' own `onChange(of:focused)` still runs, so drafts settle to
    /// canonical exactly as if the field had been blurred any other way.
    static func dismiss() {
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil
        )
    }
}

extension View {
    /// While the keyboard is up, any tap or downward swipe over this view puts
    /// it away — and does nothing else. The app's *only* dismissal affordance:
    /// there is no keyboard `Done` anywhere, deliberately, so this modifier
    /// must sit on every root that can host the keyboard. SwiftUI modifiers do
    /// not reach presented content, so each sheet needs its own copy — the one
    /// on `RootView` covers only what is in the root window's own tree.
    ///
    /// The tap is high priority, not simultaneous, and that is the point: with
    /// the keyboard up, a stray tap must not also summon a placement guide,
    /// flip a segment or arm an order. The tap is spent on the dismissal,
    /// exactly as it would be on a sheet's scrim, and the control it landed on
    /// takes the *next* tap. The swipe stays simultaneous — a drag is not a
    /// press, so nothing mis-fires by letting the chart pan while the keyboard
    /// leaves.
    ///
    /// Self-gating: the keyboard frame notifications say when a keyboard is up,
    /// so callers do not need to know which field has focus — which is what
    /// lets one copy of this serve a whole screen of fields it cannot name.
    /// While no keyboard is up the gestures are masked to `.subviews` and every
    /// touch goes exactly where it always went.
    func dismissKeyboardOnInteraction() -> some View {
        modifier(DismissKeyboardOnInteraction())
    }
}

private struct DismissKeyboardOnInteraction: ViewModifier {
    @State private var keyboardIsUp = false

    func body(content: Content) -> some View {
        content
            .highPriorityGesture(
                TapGesture().onEnded { Keyboard.dismiss() },
                including: keyboardIsUp ? .all : .subviews
            )
            .simultaneousGesture(
                DragGesture(minimumDistance: 20)
                    .onEnded { value in
                        // Downward, and more downward than sideways: a diagonal
                        // that is mostly a horizontal chart pan is not a
                        // dismissal.
                        guard value.translation.height > 40,
                            value.translation.height > abs(value.translation.width)
                        else { return }
                        Keyboard.dismiss()
                    },
                including: keyboardIsUp ? .all : .subviews
            )
            .onReceive(
                NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)
            ) { _ in
                keyboardIsUp = true
            }
            // `willChangeFrame` fires on the way down too, so the gate has to
            // be closed by the notification that actually means "gone".
            .onReceive(
                NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)
            ) { _ in
                keyboardIsUp = false
            }
    }
}
