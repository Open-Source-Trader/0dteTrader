import SwiftUI

// Preference rows (AUTO offset; later toggles land here too). An extension in
// its own file, the ProfileView+SnapTrade arrangement: ProfileView.swift is
// already past SwiftLint's file-length warning, so new rows must not grow it.
extension ProfileView {
    var preferencesCard: some View {
        VStack(alignment: .leading, spacing: AppSpacing.md) {
            sectionHeader("Preferences", icon: "slider.horizontal.3")
            autoOffsetRow
        }
        .padding(AppSpacing.lg)
        .hudCard(glow: false)
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
