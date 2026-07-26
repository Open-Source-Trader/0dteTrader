import SwiftUI

/// Server picker on the login screen: shows the current API host and, expanded,
/// lets a self-hoster paste their own backend URL, probe `/v1/health`, and save
/// it (the app rebuilds the container from `ServerConfigStore`, so login
/// immediately uses the new URL). Thin by design — validation and the health
/// probe live in `ServerConfigStore` where they are unit tested. Mirrors
/// `apps/desktop/src/features/auth/ServerSettings.tsx`.
struct ServerSettingsView: View {
    /// One-click backend template (#59). Updated when the final template publishes.
    static let railwayDeployURL = URL(string: "https://railway.com/deploy/0dtetrader-template")!

    @EnvironmentObject private var serverConfig: ServerConfigStore

    @State private var expanded = false
    @State private var draft = ""
    @State private var saveError: String?
    @State private var isChecking = false
    @State private var health: ServerConfigStore.HealthCheckResult?
    @FocusState private var isFieldFocused: Bool

    var body: some View {
        VStack(spacing: AppSpacing.sm) {
            Button {
                toggle()
            } label: {
                HStack(spacing: AppSpacing.xs) {
                    Text("Server: \(hostLabel)")
                        .foregroundStyle(.secondary)
                    Text("Edit")
                        .foregroundStyle(Color.appAccent)
                }
                .font(.footnote)
                .frame(minHeight: 32)
                .padding(.horizontal, AppSpacing.lg)
                .contentShape(Rectangle())
            }
            .buttonStyle(AppPressStyle())
            .accessibilityLabel("Server: \(hostLabel)")
            .accessibilityHint(expanded ? "Collapses server settings" : "Expands server settings")

            if expanded {
                expandedContent
            }
        }
        .animation(AppMotion.standard, value: expanded)
    }

    // MARK: - Expanded editor

    private var expandedContent: some View {
        VStack(spacing: AppSpacing.md) {
            TextField("https://your-api.up.railway.app", text: $draft)
                .textContentType(.URL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($isFieldFocused)
                .accessibilityLabel("Server URL")
                .authField(isFocused: isFieldFocused)
                .onChange(of: draft) { _, _ in
                    saveError = nil
                    health = nil
                }

            // Slot is always rendered so status changes don't shift the buttons.
            statusSlot
                .frame(minHeight: 16)

            HStack(spacing: AppSpacing.md) {
                secondaryButton("Test connection") {
                    testConnection()
                }
                secondaryButton("Save") {
                    save()
                }
                secondaryButton("Reset to default", tint: .secondary) {
                    serverConfig.reset()
                }
            }

            Text(deployFooter)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
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

    private func secondaryButton(
        _ title: String,
        tint: Color = .appAccent,
        action: @escaping () -> Void
    ) -> some View {
        Button(title, action: action)
            .font(.footnote)
            .foregroundStyle(tint)
            .frame(minHeight: 32)
            .contentShape(Rectangle())
            .buttonStyle(AppPressStyle())
    }

    /// "Deploy on Railway" renders as a tappable link inside the sentence
    /// (handled by SwiftUI's environment `openURL` — no custom handling).
    private var deployFooter: AttributedString {
        let markdown = "No backend yet? [Deploy on Railway](\(Self.railwayDeployURL.absoluteString))"
            + " — deploy your own in one click, then paste its URL here."
        return (try? AttributedString(markdown: markdown)) ?? AttributedString(markdown)
    }

    private var hostLabel: String {
        let url = serverConfig.baseURL
        guard let host = url.host else { return url.absoluteString }
        guard let port = url.port else { return host }
        return "\(host):\(port)"
    }

    // MARK: - Actions

    private func toggle() {
        expanded.toggle()
        draft = serverConfig.baseURL.absoluteString
        saveError = nil
        health = nil
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
            // Rebuilds the app container via ZeroDTETraderApp; the remounted
            // login screen shows the new host in the collapsed row.
            try serverConfig.save(draft)
        } catch {
            saveError = error.localizedDescription
        }
    }
}
