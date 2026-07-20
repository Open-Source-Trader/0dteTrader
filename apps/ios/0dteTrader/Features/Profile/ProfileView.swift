import SwiftUI

struct ProfileView: View {
    @ObservedObject var viewModel: ProfileViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var showWebullDeleteConfirmation: TradingMode? = nil
    @State private var showAlpacaDeleteConfirmation: TradingMode? = nil
    @State private var showLogoutConfirmation = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: AppSpacing.xl) {
                    accountCard
                    providerCard
                    if viewModel.tradingProvider == .alpaca {
                        alpacaCard
                    } else {
                        webullCard
                    }
                    securityCard
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
                isPresented: Binding(
                    get: { showWebullDeleteConfirmation != nil },
                    set: { if !$0 { showWebullDeleteConfirmation = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Delete Credentials", role: .destructive) {
                    if let env = showWebullDeleteConfirmation {
                        Task { await viewModel.deleteWebull(environment: env) }
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(showWebullDeleteConfirmation == .live
                     ? "Trading will stop working until new credentials are saved."
                     : "Practice trading will use the server's built-in practice app credentials.")
            }
            .confirmationDialog(
                "Remove Alpaca credentials?",
                isPresented: Binding(
                    get: { showAlpacaDeleteConfirmation != nil },
                    set: { if !$0 { showAlpacaDeleteConfirmation = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Delete Credentials", role: .destructive) {
                    if let env = showAlpacaDeleteConfirmation {
                        Task { await viewModel.deleteAlpaca(environment: env) }
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(showAlpacaDeleteConfirmation == .live
                     ? "Trading with Alpaca will stop working until new credentials are saved."
                     : "Paper trading with Alpaca will stop working until new credentials are saved.")
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
        VStack(alignment: .leading, spacing: AppSpacing.lg) {
            if viewModel.isLoading && viewModel.me == nil {
                sectionHeader("Webull API", icon: "key.fill")
                VStack(spacing: AppSpacing.sm) {
                    ForEach(0..<4, id: \.self) { _ in
                        SkeletonView()
                            .frame(height: 20)
                            .padding(.vertical, AppSpacing.xs)
                    }
                }
            } else {
                webullSection(.live)
                Divider()
                    .background(Color.hudStrokeDim.opacity(0.4))
                webullSection(.practice)
            }
        }
        .padding(AppSpacing.lg)
        .hudCard(glow: false)
        .animation(AppMotion.standard, value: viewModel.isLoading)
        .animation(AppMotion.standard, value: viewModel.me?.webullConfigured)
        .animation(AppMotion.standard, value: viewModel.me?.webullPracticeConfigured)
        .animation(AppMotion.standard, value: viewModel.editingWebull)
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

    private func webullSection(_ environment: TradingMode) -> some View {
        let me = viewModel.me
        let configured = environment == .live
            ? (me?.webullConfigured ?? false)
            : (me?.webullPracticeConfigured ?? false)
        let accountId = environment == .live ? me?.webullAccountId : me?.webullPracticeAccountId
        let title = environment == .live ? "Webull API — Live" : "Webull API — Practice"
        let editing = viewModel.editingWebull.contains(environment)
        let isDeleting = viewModel.deletingWebull.contains(environment)
        let isReconnecting = viewModel.reconnectingWebull.contains(environment)
        let isActiveEnv = me?.tradingMode == environment

        return VStack(alignment: .leading, spacing: AppSpacing.md) {
            sectionHeader(title, icon: "key.fill")

            if configured && !editing {
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
                .overlay(HudPanelShape(chamfer: 6).strokeBorder(Color.pnlPositive.opacity(0.35), lineWidth: 1))

                HStack {
                    Text("Account")
                        .font(.panelLabel)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(accountId ?? "detected after first connection")
                        .font(.priceSmall)
                        .foregroundStyle(.secondary)
                }
                .padding(AppSpacing.md)
                .background(Color.appSurface, in: HudPanelShape(chamfer: 6))
                .overlay(HudPanelShape(chamfer: 6).strokeBorder(Color.hudStrokeDim.opacity(0.5), lineWidth: 1))

                Text("Credentials are stored encrypted on the server and are never displayed here.")
                    .font(.chipLabel)
                    .foregroundStyle(.secondary)

                VStack(spacing: AppSpacing.sm) {
                    Button {
                        viewModel.setEditingWebull(environment, true)
                    } label: {
                        Text("Update Credentials")
                            .font(.panelLabel)
                            .foregroundStyle(Color.appAccent)
                            .frame(maxWidth: .infinity, minHeight: 40)
                    }
                    .buttonStyle(HudActionButtonStyle(accent: .appAccent, chamfer: 6))

                    if isActiveEnv {
                        Button {
                            Task { await viewModel.reconnect(environment: environment) }
                        } label: {
                            HStack(spacing: AppSpacing.sm) {
                                if isReconnecting { ProgressView().controlSize(.small).tint(Color.appAccent) }
                                Text("Reconnect to Webull")
                                    .font(.panelLabel)
                            }
                            .foregroundStyle(Color.appAccent)
                            .frame(maxWidth: .infinity, minHeight: 40)
                        }
                        .buttonStyle(HudActionButtonStyle(accent: .hudStrokeDim, chamfer: 6))
                        .disabled(isReconnecting)
                    }

                    Button {
                        showWebullDeleteConfirmation = environment
                    } label: {
                        Text("Delete Credentials")
                            .font(.panelLabel)
                            .foregroundStyle(Color.pnlNegative)
                            .frame(maxWidth: .infinity, minHeight: 40)
                    }
                    .buttonStyle(HudActionButtonStyle(accent: .pnlNegative.opacity(0.6), chamfer: 6))
                    .disabled(isDeleting)
                    .sensoryFeedback(.warning, trigger: showWebullDeleteConfirmation)
                }
            } else {
                WebullCredentialsForm(viewModel: viewModel, environment: environment)
                if configured {
                    Button {
                        viewModel.setEditingWebull(environment, false)
                    } label: {
                        Text("Cancel Update")
                            .font(.panelLabel)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, minHeight: 40)
                    }
                    .buttonStyle(AppPressStyle())
                }
            }

            messageView(environment)

            Text(environment == .live
                 ? "Your app key, app secret, and account ID come from the Webull OpenAPI developer portal."
                 : "Optional paper-trading credentials. If left blank, the server's built-in practice app credentials are used.")
                .font(.chipLabel)
                .foregroundStyle(.secondary)
        }
    }

    private func messageView(_ environment: TradingMode) -> some View {
        Group {
            if viewModel.messageEnv == environment, let successMessage = viewModel.successMessage {
                HStack(spacing: AppSpacing.sm) {
                    Image(systemName: "checkmark.circle.fill")
                    Text(successMessage)
                        .font(.chipLabel)
                }
                .foregroundStyle(Color.pnlPositive)
                .accessibilityAddTraits(.isStaticText)
            } else if viewModel.messageEnv == environment, let errorMessage = viewModel.errorMessage {
                HStack(spacing: AppSpacing.sm) {
                    Image(systemName: "exclamationmark.triangle.fill")
                    Text(errorMessage)
                        .font(.chipLabel)
                }
                .foregroundStyle(Color.pnlNegative)
            }
        }
    }

    // MARK: - Provider selector

    private var providerCard: some View {
        VStack(alignment: .leading, spacing: AppSpacing.md) {
            sectionHeader("Trading Provider", icon: "arrow.left.arrow.right.circle")
            HStack(spacing: AppSpacing.sm) {
                providerButton(.webull, label: "Webull")
                providerButton(.alpaca, label: "Alpaca")
            }
            .padding(AppSpacing.md)
            .background(Color.appSurface, in: HudPanelShape(chamfer: 6))
            .overlay(HudPanelShape(chamfer: 6).strokeBorder(Color.hudStrokeDim, lineWidth: 1))
            Text("Switch providers any time. Credentials for the other provider stay saved.")
                .font(.chipLabel)
                .foregroundStyle(.secondary)
        }
        .padding(AppSpacing.lg)
        .hudCard(glow: false)
    }

    private func providerButton(_ provider: BrokerProvider, label: String) -> some View {
        let selected = viewModel.tradingProvider == provider
        return Button {
            Task { await viewModel.setTradingProvider(provider) }
        } label: {
            Text(label)
                .font(.panelLabel)
                .foregroundStyle(selected ? Color.black : Color.appAccent)
                .frame(maxWidth: .infinity, minHeight: 40)
        }
        .buttonStyle(HudActionButtonStyle(accent: selected ? .appAccent : .hudStrokeDim, chamfer: 6))
    }

    // MARK: - Alpaca card

    private var alpacaCard: some View {
        VStack(alignment: .leading, spacing: AppSpacing.lg) {
            if viewModel.isLoading && viewModel.me == nil {
                sectionHeader("Alpaca API", icon: "key.fill")
                VStack(spacing: AppSpacing.sm) {
                    ForEach(0..<4, id: \.self) { _ in
                        SkeletonView()
                            .frame(height: 20)
                            .padding(.vertical, AppSpacing.xs)
                    }
                }
            } else {
                alpacaSection(.live)
                Divider()
                    .background(Color.hudStrokeDim.opacity(0.4))
                alpacaSection(.practice)
            }
        }
        .padding(AppSpacing.lg)
        .hudCard(glow: false)
        .animation(AppMotion.standard, value: viewModel.isLoading)
        .animation(AppMotion.standard, value: viewModel.me?.alpacaConfigured)
        .animation(AppMotion.standard, value: viewModel.me?.alpacaPracticeConfigured)
        .animation(AppMotion.standard, value: viewModel.editingAlpaca)
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

    private func alpacaSection(_ environment: TradingMode) -> some View {
        let me = viewModel.me
        let configured = environment == .live
            ? (me?.alpacaConfigured ?? false)
            : (me?.alpacaPracticeConfigured ?? false)
        let accountId = environment == .live ? me?.alpacaAccountId : me?.alpacaPracticeAccountId
        let title = environment == .live ? "Alpaca API — Live" : "Alpaca API — Practice"
        let editing = viewModel.editingAlpaca.contains(environment)
        let isDeleting = viewModel.deletingAlpaca.contains(environment)

        return VStack(alignment: .leading, spacing: AppSpacing.md) {
            sectionHeader(title, icon: "key.fill")

            if configured && !editing {
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
                .overlay(HudPanelShape(chamfer: 6).strokeBorder(Color.pnlPositive.opacity(0.35), lineWidth: 1))

                HStack {
                    Text("Account")
                        .font(.panelLabel)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(accountId ?? "key-scoped (no account id)")
                        .font(.priceSmall)
                        .foregroundStyle(.secondary)
                }
                .padding(AppSpacing.md)
                .background(Color.appSurface, in: HudPanelShape(chamfer: 6))
                .overlay(HudPanelShape(chamfer: 6).strokeBorder(Color.hudStrokeDim.opacity(0.5), lineWidth: 1))

                Text("Credentials are stored encrypted on the server and are never displayed here.")
                    .font(.chipLabel)
                    .foregroundStyle(.secondary)

                VStack(spacing: AppSpacing.sm) {
                    Button {
                        viewModel.setEditingAlpaca(environment, true)
                    } label: {
                        Text("Update Credentials")
                            .font(.panelLabel)
                            .foregroundStyle(Color.appAccent)
                            .frame(maxWidth: .infinity, minHeight: 40)
                    }
                    .buttonStyle(HudActionButtonStyle(accent: .appAccent, chamfer: 6))

                    Button {
                        showAlpacaDeleteConfirmation = environment
                    } label: {
                        Text("Delete Credentials")
                            .font(.panelLabel)
                            .foregroundStyle(Color.pnlNegative)
                            .frame(maxWidth: .infinity, minHeight: 40)
                    }
                    .buttonStyle(HudActionButtonStyle(accent: .pnlNegative.opacity(0.6), chamfer: 6))
                    .disabled(isDeleting)
                    .sensoryFeedback(.warning, trigger: showAlpacaDeleteConfirmation)
                }
            } else {
                AlpacaCredentialsForm(viewModel: viewModel, environment: environment)
                if configured {
                    Button {
                        viewModel.setEditingAlpaca(environment, false)
                    } label: {
                        Text("Cancel Update")
                            .font(.panelLabel)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, minHeight: 40)
                    }
                    .buttonStyle(AppPressStyle())
                }
            }

            messageView(environment)

            Text(environment == .live
                 ? "Your API key and secret come from the Alpaca dashboard (use the matching live key)."
                 : "Optional Alpaca paper key/secret for simulated trading.")
                .font(.chipLabel)
                .foregroundStyle(.secondary)
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
