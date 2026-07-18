import SwiftUI

@main
struct ZeroDTETraderApp: App {
    @StateObject private var container = AppContainer()

    var body: some Scene {
        WindowGroup {
            RootView(container: container)
                .tint(.appAccent)
        }
    }
}
