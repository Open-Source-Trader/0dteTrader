import SwiftUI

struct ProfileView: View {
    @ObservedObject var viewModel: ProfileViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var showDeleteConfirmation = false
    @State private var showLogoutConfirmation = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: AppSpacing.xl) {
                    accountCard
                    webullCard
                    securityCard
                    tradingCard
                    logoutCard
                }
                .padding(.horizontal, AppSpacing.lg)
                .padding(.top, AppSpacing.md)
                .padding(.bottom, AppSpacing.xxxl)
            }
            .background(Color.appBackground)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("Profile")
                        .font(.hudTitle)
                        .foregroundStyle(Color.appAccent)
                        .shadow(color: .hudGlow, radius: 4)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        dismiss()
                    } label: {
                        Text("Done")
                            .font(.panelLabel)
                            .foregroundStyle(Color.appAccent)
                    }
                }
            }
            .toolbarBackground(Color.appBackground, for: .navigationBar)
            .task {
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

    // MARK: - Cards

    private var accountCard: some View {
        VStack(alignment: .leading, spacing: AppSpacing.md) {
            sectionHeader("Account", icon: "person.circle")

            if let me = viewModel.me {
                HStack {
                    Text("Email")
                        .font(.panelLabel)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(me.email)
                        .font(.priceMedium)
                        .foregroundStyle(.white)
                        .textSelection(.enabled)
                }
                .padding(AppSpacing.md)
                .background(Color.appSurface, in: HudPanelShape(chamfer: 6))
                .overlay(
                    HudPanelShape(chamfer: 6)
                        .strokeBorder(Color.hudStrokeDim, lineWidth: 1)
                )

                if me.tradingDisabled {
                    HStack(spacing: AppSpacing.sm) {
                        Image(systemName: "exclamationmark.triangle.fill")
                        Text("Trading is disabled (kill switch active)")
                            .font(.chipLabel)
                    }
                    .foregroundStyle(Color.pnlNegative)
                    .padding(AppSpacing.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.pnlNegative.opacity(0.1), in: HudPanelShape(chamfer: 6))
                    .overlay(
                        HudPanelShape(chamfer: 6)
                            .strokeBorder(Color.pnlNegative.opacity(0.5), lineWidth: 1)
                    )
                }
            } else if viewModel.isLoading {
                VStack(spacing: AppSpacing.sm) {
                    SkeletonView().frame(height: 20)
                    SkeletonView().frame(height: 20)
                }
                .padding(AppSpacing.md)
            } else {
                VStack(spacing: AppSpacing.md) {
                    Label("Account details unavailable", systemImage: "wifi.exclamationmark")
                        .font(.panelLabel)
                        .foregroundStyle(.secondary)

                    Button {
                        Task { await viewModel.load() }
                    } label: {
                        Text("Retry")
                            .font(.hudButton)
                            .foregroundStyle(Color.appAccent)
                            .frame(maxWidth: .infinity, minHeight: 40)
                    }
                    .buttonStyle(HudActionButtonStyle(accent: .appAccent, chamfer: 6))
                }
                .padding(AppSpacing.md)
            }
        }
        .padding(AppSpacing.lg)
        .hudCard(glow: false)
    }

    private var webullCard: some View {
        VStack(alignment: .leading, spacing: AppSpacing.md) {
            sectionHeader("Webull API", icon: "key.fill")

            if viewModel.isLoading && viewModel.me == nil {
                VStack(spacing: AppSpacing.sm) {
                    ForEach(0..<4, id: \.self) { _ in
                        SkeletonView()
                            .frame(height: 20)
                            .padding(.vertical, AppSpacing.xs)
                    }
                }
            } else if let me = viewModel.me, me.webullConfigured, !viewModel.isEditingCredentials {
                configuredView(me: me)
            } else {
                WebullCredentialsForm(viewModel: viewModel)
                if viewModel.me?.webullConfigured == true {
                    Button {
                        viewModel.isEditingCredentials = false
                    } label: {
                        Text("Cancel Update")
                            .font(.panelLabel)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, minHeight: 40)
                    }
                    .buttonStyle(AppPressStyle())
                }
            }

            if let successMessage = viewModel.successMessage {
                HStack(spacing: AppSpacing.sm) {
                    Image(systemName: "checkmark.circle.fill")
                    Text(successMessage)
                        .font(.chipLabel)
                }
                .foregroundStyle(Color.pnlPositive)
                .accessibilityAddTraits(.isStaticText)
            }
            if let errorMessage = viewModel.errorMessage {
                HStack(spacing: AppSpacing.sm) {
                    Image(systemName: "exclamationmark.triangle.fill")
                    Text(errorMessage)
                        .font(.chipLabel)
                }
                .foregroundStyle(Color.pnlNegative)
            }

            Text("Your app key, app secret, and account ID come from the Webull OpenAPI developer portal.")
                .font(.chipLabel)
                .foregroundStyle(.secondary)
        }
        .padding(AppSpacing.lg)
        .hudCard(glow: false)
        .animation(AppMotion.standard, value: viewModel.isLoading)
        .animation(AppMotion.standard, value: viewModel.me?.webullConfigured)
        .animation(AppMotion.standard, value: viewModel.isEditingCredentials)
        .sensoryFeedback(.success, trigger: viewModel.successMessage)
        .sensoryFeedback(.error, trigger: viewModel.errorMessage)
        .onChange(of: viewModel.successMessage) { _, message in
            guard let message else { return }
            Task {
                try? await Task.sleep(for: .seconds(4))
                if viewModel.successMessage == message {
                    viewModel.successMessage = nil
                }
            }
        }
    }

    private func configuredView(me: MeDTO) -> some View {
        VStack(alignment: .leading, spacing: AppSpacing.md) {
            HStack(spacing: AppSpacing.sm) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(Color.pnlPositive)
                Text("Configured")
                    .font(.panelLabel)
                    .foregroundStyle(Color.pnlPositive)
            }
            .padding(AppSpacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.pnlPositive.opacity(0.08), in: HudPanelShape(chamfer: 6))
            .overlay(
                HudPanelShape(chamfer: 6)
                    .strokeBorder(Color.pnlPositive.opacity(0.35), lineWidth: 1)
            )

            HStack {
                Text("Account")
                    .font(.panelLabel)
                    .foregroundStyle(.secondary)
                Spacer()
                Text(me.webullAccountId ?? "detected after first connection")
                    .font(.priceSmall)
                    .foregroundStyle(.secondary)
            }
            .padding(AppSpacing.md)
            .background(Color.appSurface, in: HudPanelShape(chamfer: 6))
            .overlay(
                HudPanelShape(chamfer: 6)
                    .strokeBorder(Color.hudStrokeDim.opacity(0.5), lineWidth: 1)
            )

            Text("Credentials are stored encrypted on the server and are never displayed here.")
                .font(.chipLabel)
                .foregroundStyle(.secondary)

            VStack(spacing: AppSpacing.sm) {
                Button {
                    viewModel.isEditingCredentials = true
                } label: {
                    Text("Update Credentials")
                        .font(.panelLabel)
                        .foregroundStyle(Color.appAccent)
                        .frame(maxWidth: .infinity, minHeight: 40)
                }
                .buttonStyle(HudActionButtonStyle(accent: .appAccent, chamfer: 6))

                Button {
                    Task { await viewModel.reconnect() }
                } label: {
                    HStack(spacing: AppSpacing.sm) {
                        if viewModel.isReconnecting {
                            ProgressView().controlSize(.small).tint(Color.appAccent)
                        }
                        Text("Reconnect to Webull")
                            .font(.panelLabel)
                    }
                    .foregroundStyle(Color.appAccent)
                    .frame(maxWidth: .infinity, minHeight: 40)
                }
                .buttonStyle(HudActionButtonStyle(accent: .hudStrokeDim, chamfer: 6))
                .disabled(viewModel.isReconnecting)

                Button {
                    showDeleteConfirmation = true
                } label: {
                    Text("Delete Credentials")
                        .font(.panelLabel)
                        .foregroundStyle(Color.pnlNegative)
                        .frame(maxWidth: .infinity, minHeight: 40)
                }
                .buttonStyle(HudActionButtonStyle(accent: .pnlNegative.opacity(0.6), chamfer: 6))
                .disabled(viewModel.isDeletingCredentials)
                .sensoryFeedback(.warning, trigger: showDeleteConfirmation)
            }
        }
    }

    private var securityCard: some View {
        VStack(alignment: .leading, spacing: AppSpacing.md) {
            sectionHeader("Security", icon: "lock.shield")

            HStack {
                HStack(spacing: AppSpacing.sm) {
                    Image(systemName: "faceid")
                        .foregroundStyle(Color.appAccent)
                    Text("Require Face ID to open")
                        .font(.panelLabel)
                        .foregroundStyle(.white)
                }
                Spacer()
                Toggle("", isOn: Binding(
                    get: { viewModel.appLockEnabled },
                    set: { viewModel.setAppLockEnabled($0) }
                ))
                .labelsHidden()
                .tint(Color.appAccent)
            }
            .padding(AppSpacing.md)
            .background(Color.appSurface, in: HudPanelShape(chamfer: 6))
            .overlay(
                HudPanelShape(chamfer: 6)
                    .strokeBorder(Color.hudStrokeDim, lineWidth: 1)
            )
        }
        .padding(AppSpacing.lg)
        .hudCard(glow: false)
    }

    private var tradingCard: some View {
        VStack(alignment: .leading, spacing: AppSpacing.md) {
            sectionHeader("Trading", icon: "bolt.horizontal")

            HStack {
                HStack(spacing: AppSpacing.sm) {
                    Image(systemName: "hand.tap")
                        .foregroundStyle(Color.appAccent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Skip order confirmation")
                            .font(.panelLabel)
                            .foregroundStyle(.white)
                        Text("Places the order immediately on Buy/Sell. This device only.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Toggle("", isOn: $viewModel.bypassOrderConfirmation)
                    .labelsHidden()
                    .tint(Color.appAccent)
            }
            .padding(AppSpacing.md)
            .background(Color.appSurface, in: HudPanelShape(chamfer: 6))
            .overlay(
                HudPanelShape(chamfer: 6)
                    .strokeBorder(Color.hudStrokeDim, lineWidth: 1)
            )
        }
        .padding(AppSpacing.lg)
        .hudCard(glow: false)
    }

    private var logoutCard: some View {
        Button {
            showLogoutConfirmation = true
        } label: {
            HStack(spacing: AppSpacing.sm) {
                Image(systemName: "rectangle.portrait.and.arrow.right")
                Text("Log Out")
                    .font(.hudButton)
                    .kerning(0.5)
            }
            .foregroundStyle(Color.pnlNegative)
            .shadow(color: Color.pnlNegative.opacity(0.4), radius: 4)
            .frame(maxWidth: .infinity, minHeight: 48)
        }
        .buttonStyle(HudActionButtonStyle(accent: .pnlNegative.opacity(0.5)))
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

    // MARK: - Helpers

    private func sectionHeader(_ title: String, icon: String) -> some View {
        HStack(spacing: AppSpacing.sm) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(Color.appAccent)
            Text(title)
                .font(.panelLabel)
                .foregroundStyle(Color.appAccent)
                .shadow(color: .hudGlow, radius: 3)
        }
    }
}
