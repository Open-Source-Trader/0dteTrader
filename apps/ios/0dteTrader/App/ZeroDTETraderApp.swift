import SwiftUI

@main
struct ZeroDTETraderApp: App {
    @StateObject private var serverConfig: ServerConfigStore
    @State private var container: AppContainer
    /// App-lifetime: owns the device-global APNs registration state across
    /// server switches. Containers come and go; this does not.
    @State private var pushCoordinator: PushRegistrationCoordinator
    /// APNs registration callbacks only arrive on a UIApplicationDelegate;
    /// this one forwards them to the coordinator.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    init() {
        let serverConfig = ServerConfigStore()
        let pushCoordinator = PushRegistrationCoordinator()
        _serverConfig = StateObject(wrappedValue: serverConfig)
        _pushCoordinator = State(initialValue: pushCoordinator)
        _container = State(initialValue: AppContainer(
            baseURL: serverConfig.baseURL,
            pushCoordinator: pushCoordinator
        ))
    }

    var body: some Scene {
        WindowGroup {
            RootView(container: container)
                // New container ⇒ new RootView identity, so its state objects
                // (auth view model, sockets) are rebuilt against the new server.
                .id(ObjectIdentifier(container))
                .environmentObject(serverConfig)
                .onChange(of: serverConfig.baseURL) { _, newBaseURL in
                    // Deactivates the departing server's push binding
                    // SYNCHRONOUSLY before the new container exists, so no
                    // delivery or callback era can leak across the switch;
                    // its server-side cleanup is best-effort (the switch UI
                    // is only reachable unauthenticated) and the next
                    // sign-in on that server heals the retained slot.
                    container.pushNotifications.handleServerSwitch()
                    container = AppContainer(
                        baseURL: newBaseURL,
                        pushCoordinator: pushCoordinator
                    )
                }
                .onAppear {
                    // Wiring only — registration is driven by AUTHENTICATED
                    // screens (TradeScreenView), never by the login screen
                    // appearing.
                    appDelegate.pushCoordinator = pushCoordinator
                }
                .tint(.appAccent)
                // The HUD theme has no light variant.
                .preferredColorScheme(.dark)
        }
    }
}
