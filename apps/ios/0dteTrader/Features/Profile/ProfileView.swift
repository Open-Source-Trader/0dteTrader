import SwiftUI

struct ProfileView: View {
    @ObservedObject var viewModel: ProfileViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var showDeleteConfirmation = false
    @State private var showLogoutConfirmation = false

    var body: some View {
        NavigationStack {
            Form {
                accountSection
                webullSection
                securitySection
                sessionSection
            }
            .scrollContentBackground(.hidden)
            .background(Color.appBackground)
            .tint(Color.appAccent)
            .navigationTitle("Profile")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                // Skip the refetch (and the loading flash) when we already
                // have account state from a previous open.
                if viewModel.me == nil {
                    await viewModel.load()
                }
            }
            .confirmationDialog(
                "Remove Webull credentials?",
                isPresented: $showDeleteConfirmation,
                titleVisibility: .visible
            ) {
                Button("Delete Credentials", role: .destructive) {
                    Task { await viewModel.deleteCredentials() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Trading will stop working until new credentials are saved.")
            }
        }
    }

    // MARK: - Sections

    private var accountSection: some View {
        Section {
            if let me = viewModel.me {
                LabeledContent("Email", value: me.email)
                    .textSelection(.enabled)
                if me.tradingDisabled {
                    Label("Trading is disabled (kill switch active)", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(Color.pnlNegative)
                        .font(.footnote)
                }
            } else if viewModel.isLoading {
                ProgressView()
            } else {
                Label("Account details unavailable", systemImage: "wifi.exclamationmark")
                    .foregroundStyle(.secondary)
                Button("Retry") { Task { await viewModel.load() } }
            }
        } header: {
            Text("Account").font(.panelLabel).textCase(nil)
        }
    }

    private var webullSection: some View {
        Section {
            if viewModel.isLoading && viewModel.me == nil {
                // Skeleton rows matching SecureField row height, so configured
                // users never see the empty entry form flash while /v1/me loads.
                ForEach(0..<4, id: \.self) { _ in
                    SkeletonView()
                        .frame(height: 20)
                        .padding(.vertical, AppSpacing.md)
                }
            } else if let me = viewModel.me, me.webullConfigured, !viewModel.isEditingCredentials {
                Label("Configured", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(Color.pnlPositive)
                LabeledContent("Account") {
                    Text(me.webullAccountId ?? "detected after first connection")
                        .foregroundStyle(.secondary)
                }
                Text("Credentials are stored encrypted on the server and are never displayed here.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button("Update Credentials") {
                    viewModel.isEditingCredentials = true
                }
                Button {
                    Task { await viewModel.reconnect() }
                } label: {
                    HStack(spacing: AppSpacing.sm) {
                        if viewModel.isReconnecting {
                            ProgressView().controlSize(.small)
                        }
                        Text("Reconnect to Webull")
                    }
                }
                .disabled(viewModel.isReconnecting)
                Button("Delete Credentials", role: .destructive) {
                    showDeleteConfirmation = true
                }
                .disabled(viewModel.isDeletingCredentials)
                .sensoryFeedback(.warning, trigger: showDeleteConfirmation)
            } else {
                WebullCredentialsForm(viewModel: viewModel)
                if viewModel.me?.webullConfigured == true {
                    Button("Cancel Update") {
                        viewModel.isEditingCredentials = false
                    }
                }
            }

            if let successMessage = viewModel.successMessage {
                Label(successMessage, systemImage: "checkmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(Color.pnlPositive)
                    .accessibilityAddTraits(.isStaticText)
            }
            if let errorMessage = viewModel.errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(Color.pnlNegative)
            }
        } header: {
            Text("Webull API").font(.panelLabel).textCase(nil)
        } footer: {
            Text("Your app key, app secret, and account ID come from the Webull OpenAPI developer portal.")
        }
        .animation(AppMotion.standard, value: viewModel.isLoading)
        .animation(AppMotion.standard, value: viewModel.me?.webullConfigured)
        .animation(AppMotion.standard, value: viewModel.isEditingCredentials)
        .sensoryFeedback(.success, trigger: viewModel.successMessage)
        .sensoryFeedback(.error, trigger: viewModel.errorMessage)
        .onChange(of: viewModel.successMessage) { _, message in
            // Success feedback is transient — auto-expire so it doesn't go
            // stale under the "Configured" state.
            guard let message else { return }
            Task {
                try? await Task.sleep(for: .seconds(4))
                if viewModel.successMessage == message {
                    viewModel.successMessage = nil
                }
            }
        }
    }

    private var securitySection: some View {
        Section {
            Toggle("Require Face ID to open", isOn: Binding(
                get: { viewModel.appLockEnabled },
                set: { viewModel.setAppLockEnabled($0) }
            ))
        } header: {
            Text("Security").font(.panelLabel).textCase(nil)
        }
    }

    private var sessionSection: some View {
        Section {
            Button("Log Out", role: .destructive) {
                showLogoutConfirmation = true
            }
        }
        .confirmationDialog(
            "Log out of 0dteTrader?",
            isPresented: $showLogoutConfirmation,
            titleVisibility: .visible
        ) {
            Button("Log Out", role: .destructive) {
                Task {
                    await viewModel.logout()
                    dismiss()
                }
            }
            Button("Cancel", role: .cancel) {}
        }
    }
}
