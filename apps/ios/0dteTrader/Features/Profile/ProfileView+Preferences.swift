import SwiftUI

// Preference rows. An extension in
// its own file, the ProfileView+SnapTrade arrangement: ProfileView.swift is
// already past SwiftLint's file-length warning, so new rows must not grow it.
extension ProfileView {
    var preferencesCard: some View {
        VStack(alignment: .leading, spacing: AppSpacing.md) {
            sectionHeader("Preferences", icon: "slider.horizontal.3")
            autoScoringRow
            ivAlertRow
            toastsRow
            pushRow
        }
        .padding(AppSpacing.lg)
        .hudCard(glow: false)
    }

    private var ivAlertRow: some View {
        VStack(alignment: .leading, spacing: AppSpacing.sm) {
            HStack {
                Label("ATM IV alerts", systemImage: "waveform.path.ecg")
                    .font(.panelLabel)
                    .foregroundStyle(.white)
                Spacer()
                if viewModel.isIVAlertConfigurationBusy {
                    ProgressView()
                } else {
                    Toggle("", isOn: Binding(
                        get: { viewModel.ivAlertConfiguration?.enabled ?? false },
                        set: { viewModel.setIVAlertsEnabled($0) }
                    ))
                    .labelsHidden()
                    .tint(Color.appAccent)
                    .disabled(viewModel.ivAlertConfiguration == nil)
                    .accessibilityLabel("ATM IV alerts")
                }
            }
            Text("Expansion and crush alerts use persisted server-side median/MAD detection.")
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(spacing: AppSpacing.sm) {
                ForEach(IVAlertSymbolDTO.allCases, id: \.rawValue) { symbol in
                    let selected = viewModel.ivAlertConfiguration?.symbols.contains(symbol) == true
                    Button(symbol.rawValue) {
                        viewModel.setIVAlertSymbol(symbol, enabled: !selected)
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(selected ? Color.appBackground : Color.appAccent)
                    .padding(.horizontal, AppSpacing.sm)
                    .padding(.vertical, AppSpacing.xs)
                    .background(selected ? Color.appAccent : Color.clear, in: Capsule())
                    .overlay(Capsule().stroke(Color.appAccent, lineWidth: 1))
                    .disabled(
                        viewModel.ivAlertConfiguration == nil
                            || viewModel.isIVAlertConfigurationBusy
                    )
                    .accessibilityLabel("\(symbol.rawValue) IV alerts")
                    .accessibilityValue(selected ? "On" : "Off")
                }
            }
            if let configuration = viewModel.ivAlertConfiguration {
                IVAlertDetectionEditor(
                    configuration: configuration,
                    disabled: viewModel.isIVAlertConfigurationBusy,
                    onSave: viewModel.updateIVAlertConfiguration
                )
            }
            if let message = viewModel.ivAlertConfigurationMessage {
                Text(message)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else if viewModel.ivAlertConfiguration == nil {
                Text("Connect to load persisted IV alert settings.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(AppSpacing.md)
        .background(Color.appSurface, in: HudPanelShape(chamfer: 6))
        .overlay(HudPanelShape(chamfer: 6).strokeBorder(Color.hudStrokeDim, lineWidth: 1))
        .accessibilityElement(children: .contain)
    }

    private var autoScoringRow: some View {
        VStack(alignment: .leading, spacing: AppSpacing.sm) {
            HStack {
                Label("Scored Auto", systemImage: "scope")
                    .font(.panelLabel)
                    .foregroundStyle(.white)
                Spacer()
                if viewModel.isAutoScoringPreferenceBusy { ProgressView() }
            }
            Text("Choose the persisted scoring profile used for fresh server-side ranking.")
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(spacing: AppSpacing.sm) {
                autoPresetButton(.conservative, label: "Conservative")
                autoPresetButton(.aggressive, label: "Aggressive")
                if viewModel.autoScoringPreference?.preset == .custom {
                    Text("Custom")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.appAccent)
                }
            }
            if let preference = viewModel.autoScoringPreference {
                AutoScoringCustomEditor(
                    preference: preference,
                    busy: viewModel.isAutoScoringPreferenceBusy,
                    onSave: { preferences in
                        Task { await viewModel.saveCustomAutoScoring(preferences) }
                    }
                )
                .id(preference.updatedAt)
            }
            if let message = viewModel.autoScoringPreferenceMessage {
                Text(message)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(AppSpacing.md)
        .background(Color.appSurface, in: HudPanelShape(chamfer: 6))
        .overlay(
            HudPanelShape(chamfer: 6)
                .strokeBorder(Color.hudStrokeDim, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
    }

    private func autoPresetButton(_ preset: AutoScoringPreset, label: String) -> some View {
        Button(label) { Task { await viewModel.selectAutoScoringPreset(preset) } }
            .font(.caption.weight(.semibold))
            .foregroundStyle(
                viewModel.autoScoringPreference?.preset == preset ? Color.appBackground : Color.appAccent
            )
            .padding(.horizontal, AppSpacing.sm)
            .padding(.vertical, AppSpacing.xs)
            .background(
                viewModel.autoScoringPreference?.preset == preset ? Color.appAccent : Color.clear,
                in: Capsule()
            )
            .overlay(Capsule().stroke(Color.appAccent, lineWidth: 1))
            .disabled(viewModel.isAutoScoringPreferenceBusy || viewModel.autoScoringPreference == nil)
            .accessibilityLabel("Use \(label) Scored Auto preset")
    }

    private var pushRow: some View {
        HStack {
            HStack(spacing: AppSpacing.sm) {
                Image(systemName: "bell.and.waves.left.and.right")
                    .foregroundStyle(Color.appAccent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Push notifications")
                        .font(.panelLabel)
                        .foregroundStyle(.white)
                    Text("Order fills and rejections while the app is closed.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            Toggle("", isOn: Binding(
                get: { viewModel.pushNotificationsEnabled },
                set: { viewModel.setPushNotificationsEnabled($0) }
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

    private var toastsRow: some View {
        HStack {
            HStack(spacing: AppSpacing.sm) {
                Image(systemName: "bell.badge")
                    .foregroundStyle(Color.appAccent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("In-app toasts")
                        .font(.panelLabel)
                        .foregroundStyle(.white)
                    Text("Success and status banners. Errors always show.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            Toggle("", isOn: $viewModel.toastsEnabled)
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
}
