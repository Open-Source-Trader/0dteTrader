import SwiftUI

/// SnapTrade sections split out of ProfileView.swift to stay under
/// SwiftLint's file-length limit. Covers both halves of the Personal API
/// key model (docs.snaptrade.com/docs/personal-vs-commercial): the
/// clientId/consumerKey entry cards, and the Connection Portal cards that
/// depend on a key already being saved.
extension ProfileView {
    var snaptradeKeyCard: some View {
        VStack(alignment: .leading, spacing: AppSpacing.lg) {
            if viewModel.isLoading && viewModel.me == nil {
                sectionHeader("SnapTrade API", icon: "key.fill")
                VStack(spacing: AppSpacing.sm) {
                    ForEach(0..<4, id: \.self) { _ in
                        SkeletonView()
                            .frame(height: 20)
                            .padding(.vertical, AppSpacing.xs)
                    }
                }
            } else {
                snaptradeKeySection(.live)
                Divider()
                    .background(Color.hudStrokeDim.opacity(0.4))
                snaptradeKeySection(.practice)
            }
        }
        .padding(AppSpacing.lg)
        .hudCard(glow: false)
        .animation(AppMotion.standard, value: viewModel.isLoading)
        .animation(AppMotion.standard, value: viewModel.me?.snaptradeKeyConfigured)
        .animation(AppMotion.standard, value: viewModel.me?.snaptradeKeyPracticeConfigured)
        .animation(AppMotion.standard, value: viewModel.editingSnapTradeKey)
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

    func snaptradeKeySection(_ environment: TradingMode) -> some View {
        let me = viewModel.me
        let configured = environment == .live
            ? (me?.snaptradeKeyConfigured ?? false)
            : (me?.snaptradeKeyPracticeConfigured ?? false)
        let title = environment == .live ? "SnapTrade API — Live" : "SnapTrade API — Practice"
        let editing = viewModel.editingSnapTradeKey.contains(environment)
        let isDeleting = viewModel.deletingSnapTradeKey.contains(environment)

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

                Text("Your Personal client ID and consumer key are stored encrypted on the server and are never displayed here.")
                    .font(.chipLabel)
                    .foregroundStyle(.secondary)

                VStack(spacing: AppSpacing.sm) {
                    Button {
                        viewModel.setEditingSnapTradeKey(environment, true)
                    } label: {
                        Text("Update Credentials")
                            .font(.panelLabel)
                            .foregroundStyle(Color.appAccent)
                            .frame(maxWidth: .infinity, minHeight: 40)
                    }
                    .buttonStyle(HudActionButtonStyle(accent: .appAccent, chamfer: 6))

                    Button {
                        showSnapTradeKeyDeleteConfirmation = environment
                    } label: {
                        Text("Delete Credentials")
                            .font(.panelLabel)
                            .foregroundStyle(Color.pnlNegative)
                            .frame(maxWidth: .infinity, minHeight: 40)
                    }
                    .buttonStyle(HudActionButtonStyle(accent: .pnlNegative.opacity(0.6), chamfer: 6))
                    .disabled(isDeleting)
                    .sensoryFeedback(.warning, trigger: showSnapTradeKeyDeleteConfirmation)
                }
            } else {
                SnapTradeCredentialsForm(viewModel: viewModel, environment: environment)
                if configured {
                    Button {
                        viewModel.setEditingSnapTradeKey(environment, false)
                    } label: {
                        Text("Cancel Update")
                            .font(.panelLabel)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, minHeight: 40)
                    }
                    .buttonStyle(AppPressStyle())
                }
            }

            messageView(.snaptrade, environment)

            Text("Create a free Personal client ID and consumer key in your own SnapTrade "
                 + "Dashboard — this identifies you directly to SnapTrade, not 0dteTrader.")
                .font(.chipLabel)
                .foregroundStyle(.secondary)
        }
    }

    var snaptradeCard: some View {
        VStack(alignment: .leading, spacing: AppSpacing.lg) {
            if viewModel.isLoading && viewModel.me == nil {
                sectionHeader("SnapTrade", icon: "arrow.triangle.2.circlepath")
                VStack(spacing: AppSpacing.sm) {
                    ForEach(0..<3, id: \.self) { _ in
                        SkeletonView()
                            .frame(height: 20)
                            .padding(.vertical, AppSpacing.xs)
                    }
                }
            } else {
                snaptradeSection(.live)
                Divider()
                    .background(Color.hudStrokeDim.opacity(0.4))
                snaptradeSection(.practice)
            }
        }
        .padding(AppSpacing.lg)
        .hudCard(glow: false)
        .animation(AppMotion.standard, value: viewModel.isLoading)
        .animation(AppMotion.standard, value: viewModel.snapTradeStatus)
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

    func snaptradeSection(_ environment: TradingMode) -> some View {
        let isConnecting = viewModel.connectingSnaptrade.contains(environment)
        let isReconnecting = viewModel.reconnectingSnaptrade.contains(environment)
        let isDisconnecting = viewModel.disconnectingSnaptrade.contains(environment)
        let title = environment == .live ? "SnapTrade — Live" : "SnapTrade — Practice"
        let keyConfigured = environment == .live
            ? (viewModel.me?.snaptradeKeyConfigured ?? false)
            : (viewModel.me?.snaptradeKeyPracticeConfigured ?? false)
        let activeConnection = keyConfigured
            ? viewModel.snapTradeConnections[environment]?.first { $0.status == "active" }
            : nil

        return VStack(alignment: .leading, spacing: AppSpacing.md) {
            sectionHeader(title, icon: "arrow.triangle.2.circlepath")

            if let connection = activeConnection {
                HStack(spacing: AppSpacing.sm) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Color.pnlPositive)
                    Text("Connected to \(connection.brokerage)")
                        .font(.panelLabel)
                        .foregroundStyle(Color.pnlPositive)
                }
                .padding(AppSpacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.pnlPositive.opacity(0.08), in: HudPanelShape(chamfer: 6))
                .overlay(HudPanelShape(chamfer: 6).strokeBorder(Color.pnlPositive.opacity(0.35), lineWidth: 1))

                let accounts = viewModel.snapTradeAccounts[environment]?[connection.connectionId] ?? []
                let selectedAccountId = viewModel.snapTradeStatus[environment]?.selectedAccountId

                if accounts.isEmpty {
                    HStack {
                        Text("Account")
                            .font(.panelLabel)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(selectedAccountId ?? "select below")
                            .font(.priceSmall)
                            .foregroundStyle(.secondary)
                    }
                    .padding(AppSpacing.md)
                    .background(Color.appSurface, in: HudPanelShape(chamfer: 6))
                    .overlay(HudPanelShape(chamfer: 6).strokeBorder(Color.hudStrokeDim.opacity(0.5), lineWidth: 1))
                } else {
                    VStack(alignment: .leading, spacing: AppSpacing.sm) {
                        Text("Account")
                            .font(.panelLabel)
                            .foregroundStyle(.secondary)
                        Picker("", selection: Binding(
                            get: { selectedAccountId ?? "" },
                            set: { newValue in
                                guard !newValue.isEmpty else { return }
                                Task {
                                    await viewModel.selectSnapTradeAccount(
                                        environment: environment,
                                        connectionId: connection.connectionId,
                                        accountId: newValue
                                    )
                                }
                            }
                        )) {
                            Text("Select account…").tag("")
                            ForEach(accounts, id: \.accountId) { account in
                                Text("\(account.name) (\(account.accountId))").tag(account.accountId)
                            }
                        }
                        .pickerStyle(.menu)
                        .tint(Color.appAccent)
                    }
                    .padding(AppSpacing.md)
                    .background(Color.appSurface, in: HudPanelShape(chamfer: 6))
                    .overlay(HudPanelShape(chamfer: 6).strokeBorder(Color.hudStrokeDim.opacity(0.5), lineWidth: 1))
                }

                Text("Credentials are managed through SnapTrade's Connection Portal.")
                    .font(.chipLabel)
                    .foregroundStyle(.secondary)

                VStack(spacing: AppSpacing.sm) {
                    Button {
                        Task { await viewModel.reconnectSnapTrade(environment: environment, connectionId: connection.connectionId) }
                    } label: {
                        HStack(spacing: AppSpacing.sm) {
                            if isReconnecting { ProgressView().controlSize(.small).tint(Color.appAccent) }
                            Text("Reconnect to Brokerage")
                                .font(.panelLabel)
                        }
                        .foregroundStyle(Color.appAccent)
                        .frame(maxWidth: .infinity, minHeight: 40)
                    }
                    .buttonStyle(HudActionButtonStyle(accent: .hudStrokeDim, chamfer: 6))
                    .disabled(isReconnecting)

                    Button {
                        showSnapTradeDeleteConfirmation = (environment, connection.connectionId)
                    } label: {
                        Text("Disconnect Brokerage")
                            .font(.panelLabel)
                            .foregroundStyle(Color.pnlNegative)
                            .frame(maxWidth: .infinity, minHeight: 40)
                    }
                    .buttonStyle(HudActionButtonStyle(accent: .pnlNegative.opacity(0.6), chamfer: 6))
                    .disabled(isDisconnecting)
                }
            } else if keyConfigured {
                Text("No brokerage connected yet.")
                    .font(.panelLabel)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Button {
                    Task { await viewModel.connectSnapTrade(environment: environment) }
                } label: {
                    HStack(spacing: AppSpacing.sm) {
                        if isConnecting { ProgressView().controlSize(.small).tint(Color.appAccent) }
                        Text("Connect Brokerage")
                            .font(.panelLabel)
                    }
                    .foregroundStyle(Color.appAccent)
                    .frame(maxWidth: .infinity, minHeight: 40)
                }
                .buttonStyle(HudActionButtonStyle(accent: .appAccent, chamfer: 6))
                .disabled(isConnecting)
            } else {
                Text("Save your SnapTrade Personal client ID and consumer key above first.")
                    .font(.panelLabel)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            messageView(.snaptrade, environment)

            Text("Connect your own brokerage account through SnapTrade's secure Connection "
                 + "Portal, using the Personal client ID above. 0dteTrader never sees your "
                 + "brokerage credentials.")
                .font(.chipLabel)
                .foregroundStyle(.secondary)
        }
    }
}
