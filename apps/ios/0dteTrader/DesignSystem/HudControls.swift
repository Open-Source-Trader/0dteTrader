import SwiftUI

/// Chamfered segmented control replacing `.pickerStyle(.segmented)` —
/// UISegmentedControl can't take the HUD silhouette. Selection keeps the
/// same haptic and exposes the standard `isSelected` accessibility trait.
struct HudSegmentedControl<Value: Hashable>: View {
    struct Option {
        let value: Value
        let label: String
        /// Per-option accent (Call green / Put red); falls back to `accent`.
        var optionAccent: Color?

        init(_ value: Value, _ label: String, accent: Color? = nil) {
            self.value = value
            self.label = label
            self.optionAccent = accent
        }
    }

    let options: [Option]
    @Binding var selection: Value
    var accent: Color = .hudStroke

    var body: some View {
        HStack(spacing: AppSpacing.xs) {
            ForEach(options, id: \.value) { option in
                let isSelected = option.value == selection
                let tint = option.optionAccent ?? accent
                Button {
                    guard !isSelected else { return }
                    Haptics.selection()
                    selection = option.value
                } label: {
                    Text(option.label)
                        .font(.panelLabel)
                        .fontWeight(.semibold)
                        .foregroundStyle(isSelected ? tint : Color.secondary)
                        .frame(maxWidth: .infinity, minHeight: 34)
                        .background {
                            if isSelected {
                                HudPanelShape(chamfer: 6)
                                    .fill(tint.opacity(0.18))
                                    .overlay {
                                        HudPanelShape(chamfer: 6)
                                            .strokeBorder(tint, lineWidth: 1.2)
                                    }
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(AppPressStyle())
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .padding(AppSpacing.xxs)
        .background {
            HudPanelShape(chamfer: 8)
                .fill(accent.opacity(0.08))
                .overlay {
                    HudPanelShape(chamfer: 8)
                        .strokeBorder(accent.opacity(0.35), lineWidth: 1)
                }
        }
        .accessibilityElement(children: .contain)
    }
}

/// Chamfered on/off chip (the AUTO toggle). Amber outline + glow when on.
struct HudToggleChip: View {
    let title: String
    @Binding var isOn: Bool
    var accent: Color = .hudAmber
    var icon: String = "checkmark.circle"

    var body: some View {
        Button {
            Haptics.selection()
            isOn.toggle()
        } label: {
            HStack(spacing: AppSpacing.xs) {
                Image(systemName: isOn ? "checkmark.circle.fill" : icon)
                    .font(.caption)
                Text(title)
                    .font(.hudButton)
            }
            .foregroundStyle(isOn ? accent : Color.secondary)
            .padding(.horizontal, AppSpacing.md)
            .frame(minHeight: 34)
            .background {
                HudPanelShape(chamfer: 6)
                    .fill(isOn ? accent.opacity(0.14) : Color.hudPanel)
                    .overlay {
                        HudPanelShape(chamfer: 6)
                            .strokeBorder(
                                isOn ? accent : Color.hudStroke.opacity(0.35),
                                lineWidth: 1.2
                            )
                    }
                    .compositingGroup()
                    .shadow(color: isOn ? accent.opacity(0.45) : .clear, radius: 5)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(AppPressStyle())
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}
