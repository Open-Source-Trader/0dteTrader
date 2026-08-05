import SwiftUI

extension ProfileView {
    var discordCard: some View {
        VStack(alignment: .leading, spacing: AppSpacing.md) {
            Label("Discord", systemImage: "bubble.left.and.bubble.right.fill")
                .font(.panelLabel)
                .foregroundStyle(Color.appAccent)

            SecureField(
                viewModel.discordSettings?.maskedWebhookUrl
                    ?? "https://discord.com/api/webhooks/...",
                text: $discordWebhookURL
            )
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .textContentType(.URL)
            .padding(AppSpacing.md)
            .background(Color.appSurface, in: HudPanelShape(chamfer: 6))

            Toggle("Post filled orders", isOn: $discordEnabled)
                .font(.panelLabel)
                .tint(Color.appAccent)
            Toggle("Include realized P/L", isOn: $discordIncludePnl)
                .font(.panelLabel)
                .tint(Color.appAccent)

            HStack(spacing: AppSpacing.sm) {
                Button("Save") {
                    Task {
                        await viewModel.saveDiscord(
                            webhookUrl: discordWebhookURL,
                            enabled: discordEnabled,
                            includePnl: discordIncludePnl
                        )
                        if viewModel.errorMessage == nil { discordWebhookURL = "" }
                    }
                }
                .buttonStyle(HudActionButtonStyle(accent: .appAccent, chamfer: 6))

                Button("Send Test") {
                    Task { await viewModel.testDiscord() }
                }
                .buttonStyle(HudActionButtonStyle(accent: .appAccent, chamfer: 6))
                .disabled(viewModel.discordSettings?.configured != true)
            }
            .disabled(viewModel.isComplianceBusy)
        }
        .padding(AppSpacing.lg)
        .hudCard(glow: false)
    }

    var legalCard: some View {
        VStack(alignment: .leading, spacing: AppSpacing.md) {
            Label("About & Legal", systemImage: "doc.text.fill")
                .font(.panelLabel)
                .foregroundStyle(Color.appAccent)

            ForEach(viewModel.legalStatus?.documents ?? []) { document in
                Button {
                    Task { await viewModel.showLegalDocument(document.slug) }
                } label: {
                    HStack {
                        Text(document.title)
                            .font(.panelLabel)
                            .foregroundStyle(.white)
                        Spacer()
                        if document.requiresAcceptance {
                            Text(document.accepted == true ? "Accepted" : "Review")
                                .font(.chipLabel)
                                .foregroundStyle(
                                    document.accepted == true ? Color.pnlPositive : Color.appAccent
                                )
                        }
                        Image(systemName: "chevron.right")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, AppSpacing.xs)
                }
                .buttonStyle(AppPressStyle())
            }

            if let document = viewModel.selectedLegalDocument {
                Divider().background(Color.hudStrokeDim)
                Text(document.title)
                    .font(.panelLabel)
                    .foregroundStyle(Color.appAccent)
                Text(document.markdown)
                    .font(.chipLabel)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                if document.requiresAcceptance,
                   viewModel.legalStatus?.documents.first(where: { $0.slug == document.slug })?.accepted != true {
                    Button("Accept \(document.title)") {
                        Task { await viewModel.acceptLegal(document) }
                    }
                    .buttonStyle(HudActionButtonStyle(accent: .appAccent, chamfer: 6))
                }
                Button("Close Document") { viewModel.closeLegalDocument() }
                    .font(.chipLabel)
                    .foregroundStyle(Color.appAccent)
            }
        }
        .padding(AppSpacing.lg)
        .hudCard(glow: false)
    }

    var deleteAccountCard: some View {
        VStack(alignment: .leading, spacing: AppSpacing.md) {
            Label("Delete Account", systemImage: "trash.fill")
                .font(.panelLabel)
                .foregroundStyle(Color.pnlNegative)
            Text("Enter your account email. This permanently removes credentials, orders, devices, and settings.")
                .font(.chipLabel)
                .foregroundStyle(.secondary)
            TextField(viewModel.me?.email ?? "you@example.com", text: $deleteAccountEmail)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.emailAddress)
                .padding(AppSpacing.md)
                .background(Color.appSurface, in: HudPanelShape(chamfer: 6))
            Button("Permanently Delete Account", role: .destructive) {
                showAccountDeleteConfirmation = true
            }
            .buttonStyle(HudActionButtonStyle(accent: .pnlNegative, chamfer: 6))
            .disabled(deleteAccountEmail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(AppSpacing.lg)
        .hudCard(glow: false)
        .confirmationDialog(
            "Permanently delete this account and all stored data?",
            isPresented: $showAccountDeleteConfirmation,
            titleVisibility: .visible
        ) {
            Button("Delete Account", role: .destructive) {
                Task { await viewModel.deleteAccount(confirmEmail: deleteAccountEmail) }
            }
            Button("Cancel", role: .cancel) {}
        }
    }
}
