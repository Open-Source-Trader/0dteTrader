import SwiftUI

struct AIAnalysisButton: View {
    let action: () -> Void

    var body: some View {
        if #available(iOS 26, *) {
            Button {
                Haptics.selection()
                action()
            } label: {
                Image(systemName: "brain.head.profile")
            }
            .accessibilityLabel("AI Analysis")
        }
    }
}
