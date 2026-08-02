import SwiftUI

@main
struct ZeroDTETraderApp: App {
    @StateObject private var serverConfig: ServerConfigStore
    @State private var container: AppContainer
    /// APNs registration callbacks only arrive on a UIApplicationDelegate;
    /// this one forwards them to the container's push manager.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

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
                    // No push teardown here on purpose: the switch UI is only
                    // reachable while unauthenticated, so a DELETE against the
                    // departing server could never authenticate. Its token
                    // slot is per-server and survives — the next sign-in THERE
                    // sweeps or re-upserts it (see PushNotificationsManager).
                    container = AppContainer(baseURL: newBaseURL)
                    appDelegate.pushNotifications = container.pushNotifications
                }
                .onAppear {
                    appDelegate.pushNotifications = container.pushNotifications
                    container.pushNotifications.start()
                }
                .tint(.appAccent)
                // The HUD theme has no light variant.
                .preferredColorScheme(.dark)
        }
    }
}
