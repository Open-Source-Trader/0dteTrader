import SwiftUI

struct ProfileView: View {
    @ObservedObject var viewModel: ProfileViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var showDeleteConfirmation = false

    var body: some View {
        NavigationStack {
            Form {
                accountSection
                webullSection
                securitySection
                sessionSection
            }
            .navigationTitle("Profile")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                await viewModel.load()
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
        Section("Account") {
            if let me = viewModel.me {
                LabeledContent("Email", value: me.email)
                if me.tradingDisabled {
                    Label("Trading is disabled (kill switch active)", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(Color.pnlNegative)
                        .font(.footnote)
                }
            } else if viewModel.isLoading {
                ProgressView()
            } else {
                Text("Account details unavailable")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var webullSection: some View {
        Section {
            if let me = viewModel.me, me.webullConfigured, !viewModel.isEditingCredentials {
                Label("Configured", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(Color.pnlPositive)
                Text("Credentials are stored encrypted on the server and are never displayed here.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button("Update Credentials") {
                    viewModel.isEditingCredentials = true
                }
                Button("Delete Credentials", role: .destructive) {
                    showDeleteConfirmation = true
                }
                .disabled(viewModel.isDeletingCredentials)
            } else {
                WebullCredentialsForm(viewModel: viewModel)
                if viewModel.me?.webullConfigured == true {
                    Button("Cancel Update") {
                        viewModel.isEditingCredentials = false
                    }
                }
            }

            if let successMessage = viewModel.successMessage {
                Text(successMessage)
                    .font(.footnote)
                    .foregroundStyle(Color.pnlPositive)
            }
            if let errorMessage = viewModel.errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(Color.pnlNegative)
            }
        } header: {
            Text("Webull API")
        } footer: {
            Text("Your app key, app secret, and account ID come from the Webull OpenAPI developer portal.")
        }
    }

    private var securitySection: some View {
        Section("Security") {
            Toggle("Require Face ID to open", isOn: $viewModel.appLockEnabled)
        }
    }

    private var sessionSection: some View {
        Section {
            Button("Log Out", role: .destructive) {
                Task {
                    await viewModel.logout()
                    dismiss()
                }
            }
        }
    }
}
