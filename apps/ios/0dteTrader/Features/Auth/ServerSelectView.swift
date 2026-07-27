import SwiftUI

/// Shared constants for the server picker. Mirrors
/// `apps/desktop/src/features/auth/serverSelect.ts`.
enum ServerSelect {
    /// One-click backend template (#59). Updated when the final template publishes.
    static let railwayDeployURL = URL(string: "https://railway.com/deploy/0dtetrader-template")!

    /// Compact host shown in the login footer and the default-server card.
    static func hostLabel(_ url: URL) -> String {
        guard let host = url.host else { return url.absoluteString }
        guard let port = url.port else { return host }
        return "\(host):\(port)"
    }
}

/// Full-height server picker shown before account creation (and from the
/// "Server: … · Change" link on the login screen). Three options: the built-in
/// default backend, connecting an existing self-hosted backend, or deploying a
/// new one on Railway. Thin by design — URL validation and the health probe
/// live in `ServerConfigStore` where they are unit tested. Mirrors
/// `apps/desktop/src/features/auth/ServerSelectView.tsx`.
struct ServerSelectView: View {
    @EnvironmentObject private var serverConfig: ServerConfigStore
    @Environment(\.dismiss) private var dismiss

    /// Called once a server is chosen. `serverChanged` is true when the base
    /// URL actually changed (which rebuilds the app container and remounts the
    /// login screen), so the caller knows whether its local state survives.
    let onContinue: (_ serverChanged: Bool) -> Void

    private enum Step {
        case choose, connect, deploy

        var title: String {
            switch self {
            case .choose: return "Choose Your Server"
            case .connect: return "My Railway Backend"
            case .deploy: return "Deploy a Backend"
            }
        }
    }

    @State private var step: Step = .choose

    private var isDefault: Bool {
        serverConfig.baseURL == AppConfig.defaultAPIBaseURL
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: AppSpacing.lg) {
                    switch step {
                    case .choose: chooseStep
                    case .connect: connectStep
                    case .deploy: deployStep
                    }
                }
                .padding(AppSpacing.xxl)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Color.appBackground)
            .navigationTitle(step.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if step == .choose {
                        Button("Cancel") { dismiss() }
                    } else {
                        Button("Back") { step = .choose }
                    }
                }
            }
            .animation(AppMotion.standard, value: step)
        }
    }

    // MARK: - Choose

    private var chooseStep: some View {
        Group {
            subtitle("Pick the backend this app connects to.")

            ServerCard(
                title: "Default server",
                description: "Use the built-in backend — \(ServerSelect.hostLabel(AppConfig.defaultAPIBaseURL)).",
                isCurrent: isDefault
            ) {
                useDefault()
            }
            ServerCard(
                title: "My Railway backend",
                description: "Already hosting your own? Connect it.",
                isCurrent: !isDefault
            ) {
                step = .connect
            }
            ServerCard(
                title: "Deploy a new backend",
                description: "One click on Railway — free to start."
            ) {
                step = .deploy
            }
        }
    }

    private func useDefault() {
        let changed = !isDefault
        serverConfig.reset()
        onContinue(changed)
    }

    // MARK: - Connect

    private var connectStep: some View {
        Group {
            subtitle("Paste your backend's URL and test the connection.")
            ServerUrlForm(
                initialDraft: isDefault ? "" : serverConfig.baseURL.absoluteString,
                onContinue: onContinue
            )
        }
    }

    // MARK: - Deploy

    private var deployStep: some View {
        Group {
            VStack(alignment: .leading, spacing: AppSpacing.sm) {
                instruction(1, "Press Deploy and sign in to Railway.")
                instruction(2, "Wait for the services to go green.")
                instruction(3, "Copy the api service's public URL and paste it below.")
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Link(destination: ServerSelect.railwayDeployURL) {
                Text("Deploy on Railway")
                    .font(.hudButton)
                    .kerning(1)
                    .foregroundStyle(Color.appAccent)
                    .shadow(color: .hudGlow, radius: 6)
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .contentShape(Rectangle())
            }
            .buttonStyle(HudActionButtonStyle(accent: .appAccent))

            ServerUrlForm(
                initialDraft: isDefault ? "" : serverConfig.baseURL.absoluteString,
                onContinue: onContinue
            )
        }
    }

    private func instruction(_ number: Int, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: AppSpacing.sm) {
            Text("\(number).")
                .foregroundStyle(Color.appAccent)
            Text(text)
                .foregroundStyle(.secondary)
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
    }

    private func subtitle(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
    }
}

/// One stacked option on the choose step: title (+ CURRENT badge when it's the
/// active choice), description, chamfered surface card with an accent border
/// when current — the SwiftUI analog of desktop's `.server-card`.
private struct ServerCard: View {
    let title: String
    let description: String
    var isCurrent = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: AppSpacing.xs) {
                HStack(alignment: .firstTextBaseline, spacing: AppSpacing.sm) {
                    Text(title)
                        .font(.headline)
                        .foregroundStyle(.primary)
                    if isCurrent {
                        Text("CURRENT")
                            .font(.caption2.weight(.bold))
                            .kerning(1)
                            .foregroundStyle(Color.appAccent)
                    }
                }
                Text(description)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(AppSpacing.lg)
            .background(Color.appSurface, in: HudPanelShape(chamfer: 8))
            .overlay(
                HudPanelShape(chamfer: 8)
                    .strokeBorder(isCurrent ? Color.appAccent : Color.appBorder, lineWidth: 1)
            )
            .contentShape(HudPanelShape(chamfer: 8))
        }
        .buttonStyle(AppPressStyle())
        .accessibilityElement(children: .combine)
        .accessibilityHint(isCurrent ? "Currently selected server" : "")
    }
}

/// Shared URL entry for the connect/deploy steps: field, health probe, and a
/// Continue that persists via `ServerConfigStore` (which rebuilds the container).
private struct ServerUrlForm: View {
    @EnvironmentObject private var serverConfig: ServerConfigStore

    let initialDraft: String
    let onContinue: (_ serverChanged: Bool) -> Void

    @State private var draft: String
    @State private var saveError: String?
    @State private var isChecking = false
    @State private var health: ServerConfigStore.HealthCheckResult?
    @FocusState private var isFieldFocused: Bool

    init(initialDraft: String, onContinue: @escaping (_ serverChanged: Bool) -> Void) {
        self.initialDraft = initialDraft
        self.onContinue = onContinue
        _draft = State(initialValue: initialDraft)
    }

    var body: some View {
        VStack(spacing: AppSpacing.md) {
            TextField("https://your-api.up.railway.app", text: $draft)
                .textContentType(.URL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($isFieldFocused)
                .submitLabel(.go)
                .onSubmit { save() }
                .accessibilityLabel("Server URL")
                .authField(isFocused: isFieldFocused)
                .onChange(of: draft) { _, _ in
                    saveError = nil
                    health = nil
                }

            // Slot is always rendered so status changes don't shift the buttons.
            statusSlot
                .frame(minHeight: 16)

            Button("Test connection") {
                testConnection()
            }
            .font(.footnote)
            .foregroundStyle(Color.appAccent)
            .frame(minHeight: 32)
            .contentShape(Rectangle())
            .buttonStyle(AppPressStyle())

            AuthPrimaryButton(title: "Continue", accessibilityID: "serverSelect.continue") {
                save()
            }
        }
    }

    @ViewBuilder
    private var statusSlot: some View {
        if let saveError {
            statusText(saveError, isPositive: false)
        } else if isChecking {
            ProgressView()
                .controlSize(.small)
                .tint(.appAccent)
        } else if let health {
            statusText("\(health.ok ? "✓" : "✗") \(health.message)", isPositive: health.ok)
        }
    }

    private func statusText(_ message: String, isPositive: Bool) -> some View {
        Text(message)
            .font(.footnote)
            .foregroundStyle(isPositive ? Color.pnlPositive : Color.pnlNegative)
            .multilineTextAlignment(.center)
            .accessibilityAddTraits(.updatesFrequently)
    }

    private func testConnection() {
        guard !isChecking else { return }
        isChecking = true
        health = nil
        let input = draft
        Task {
            health = await ServerConfigStore.checkHealth(of: input)
            isChecking = false
        }
    }

    private func save() {
        do {
            let previous = serverConfig.baseURL
            let saved = try serverConfig.save(draft)
            onContinue(saved != previous)
        } catch {
            saveError = error.localizedDescription
        }
    }
}
