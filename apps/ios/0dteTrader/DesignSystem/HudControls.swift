import SwiftUI

/// Chamfered segmented control replacing `.pickerStyle(.segmented)` —
/// UISegmentedControl can't take the HUD silhouette. Selection keeps the
/// same haptic and exposes the standard `isSelected` accessibility trait.
///
/// `Center` is content laid *between* the segments, so a two-option control can
/// put its choices at the two ends of a row with something else in the middle.
/// The order-type row wants exactly that — Mid hard left, Market hard right,
/// the contract's bid/mid/ask between them — and the two must still read as one
/// either/or rather than as two independent toggles, so they stay inside the
/// one track instead of being split into two controls.
struct HudSegmentedControl<Value: Hashable, Center: View>: View {
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
    /// Segment min height — the trade panel's density tiers shrink this
    /// (desktop parity: .segmented 36/32/30px per roomy/compact/dense).
    var minHeight: CGFloat = 34
    /// Overrides the label colour on both segments. The order-type row takes it:
    /// the panel's chrome text is one grey now, and which segment is chosen is
    /// still said by the tint's border and fill.
    var labelColor: Color?
    @ViewBuilder var center: () -> Center

    /// Whether anything is actually laid between the segments. With a centre the
    /// segments hug their labels at the two ends of the row; without one they
    /// split the track evenly, as a segmented control always has.
    private var hasCenter: Bool { Center.self != EmptyView.self }

    /// Floor on a hugging segment, so "Mid" and "Market" come out close enough
    /// in width to read as a matched pair of ends rather than as a small button
    /// and a large one.
    private static var huggingSegmentWidth: CGFloat { 68 }

    var body: some View {
        HStack(spacing: AppSpacing.xs) {
            ForEach(Array(options.enumerated()), id: \.element.value) { index, option in
                if index == 1 { center() }
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
                        .foregroundStyle(labelColor ?? (isSelected ? tint : Color.secondary))
                        .frame(
                            minWidth: hasCenter ? Self.huggingSegmentWidth : 0,
                            maxWidth: hasCenter ? nil : .infinity,
                            minHeight: minHeight
                        )
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

extension HudSegmentedControl where Center == EmptyView {
    /// The plain control: two or more segments splitting the track evenly.
    init(
        options: [Option],
        selection: Binding<Value>,
        accent: Color = .hudStroke,
        minHeight: CGFloat = 34,
        labelColor: Color? = nil
    ) {
        self.init(
            options: options,
            selection: selection,
            accent: accent,
            minHeight: minHeight,
            labelColor: labelColor,
            center: { EmptyView() }
        )
    }
}

/// Chamfered on/off chip (the AUTO toggle). Amber outline + glow when on.
struct HudToggleChip: View {
    /// Nil for a chip whose glyph already says everything — a padlock does not
    /// need the word LOCK beside it. Square-ish then, so it keeps a real target.
    var title: String?
    @Binding var isOn: Bool
    var accent: Color = .hudAmber
    var icon: String = "checkmark.circle"
    /// Glyph for the on state. Defaults to the confirmation check AUTO uses;
    /// a chip whose two states are a thing and its opposite (the trading lock)
    /// says so with its own pair.
    var onIcon: String = "checkmark.circle.fill"

    var body: some View {
        Button {
            Haptics.selection()
            isOn.toggle()
        } label: {
            HStack(spacing: AppSpacing.xs) {
                Image(systemName: isOn ? onIcon : icon)
                    .font(.caption)
                if let title {
                    Text(title)
                        .font(.hudButton)
                }
            }
            .foregroundStyle(isOn ? accent : Color.secondary)
            .padding(.horizontal, AppSpacing.md)
            // A glyph on its own would shrink to the icon's width, so hold the
            // chip square rather than letting the target collapse with the label.
            .frame(minWidth: title == nil ? 34 : 0, minHeight: 34)
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
