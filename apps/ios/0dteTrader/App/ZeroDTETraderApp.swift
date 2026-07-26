import SwiftUI

@main
struct ZeroDTETraderApp: App {
    @StateObject private var serverConfig: ServerConfigStore
    @State private var container: AppContainer

    init() {
        let serverConfig = ServerConfigStore()
        _serverConfig = StateObject(wrappedValue: serverConfig)
        _container = State(initialValue: AppContainer(baseURL: serverConfig.baseURL))
    }

    var body: some Scene {
        WindowGroup {
            RootView(container: container)
                // New container ⇒ new RootView identity, so its state objects
                // (auth view model, sockets) are rebuilt against the new server.
                .id(ObjectIdentifier(container))
                .environmentObject(serverConfig)
                .onChange(of: serverConfig.baseURL) { _, newBaseURL in
                    container = AppContainer(baseURL: newBaseURL)
                }
                .tint(.appAccent)
                // The HUD theme has no light variant.
                .preferredColorScheme(.dark)
        }
    }
}
