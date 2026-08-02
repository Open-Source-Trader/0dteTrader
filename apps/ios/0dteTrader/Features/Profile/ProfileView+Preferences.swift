import SwiftUI

// Preference rows (AUTO offset; later toggles land here too). An extension in
// its own file, the ProfileView+SnapTrade arrangement: ProfileView.swift is
// already past SwiftLint's file-length warning, so new rows must not grow it.
extension ProfileView {
    var preferencesCard: some View {
        VStack(alignment: .leading, spacing: AppSpacing.md) {
            sectionHeader("Preferences", icon: "slider.horizontal.3")
            autoOffsetRow
            toastsRow
            pushRow
        }
        .padding(AppSpacing.lg)
        .hudCard(glow: false)
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

    private var autoOffsetRow: some View {
        HStack {
            HStack(spacing: AppSpacing.sm) {
                Image(systemName: "scope")
                    .foregroundStyle(Color.appAccent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("AUTO selection")
                        .font(.panelLabel)
                        .foregroundStyle(.white)
                    Text(autoOffsetDescription)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            Text(viewModel.autoOtmOffset == 0 ? "ATM" : "+\(viewModel.autoOtmOffset)")
                .font(.priceMedium)
                .foregroundStyle(Color.appAccent)
            Stepper("", value: $viewModel.autoOtmOffset, in: 0...5)
                .labelsHidden()
                .fixedSize()
                .accessibilityLabel("AUTO strikes out of the money")
                .accessibilityValue(viewModel.autoOtmOffset == 0
                    ? "At the money"
                    : "\(viewModel.autoOtmOffset)")
        }
        .padding(AppSpacing.md)
        .background(Color.appSurface, in: HudPanelShape(chamfer: 6))
        .overlay(
            HudPanelShape(chamfer: 6)
                .strokeBorder(Color.hudStrokeDim, lineWidth: 1)
        )
    }

    private var autoOffsetDescription: String {
        switch viewModel.autoOtmOffset {
        case 0: return "AUTO trades the at-the-money strike."
        case 1: return "AUTO trades 1 strike out of the money."
        default: return "AUTO trades \(viewModel.autoOtmOffset) strikes out of the money."
        }
    }
}
