import SwiftUI

/// Indicator toggles and parameters (PRD FR-7). Bound to the chart view model's
/// settings; changes persist via SettingsStore.
///
/// The body of the indicator chip's dropdown, which is where this used to be a
/// half-height sheet. It is not a `HudMenuList`: nothing here is a choice
/// between rows, it is a form of switches and steppers, so it takes the
/// anchored panel and the drop animation the other popups take and keeps its
/// own content inside them. Same treatment, not the same container.
///
/// Two things the sheet gave it for free have to be supplied now. The TWC
/// script's own screen was a `NavigationLink`, and a dropdown has no navigation
/// stack, so it closes this popup and opens that sheet — the arrangement the
/// desktop already used. And the models arrive as objects rather than as
/// bindings: an anchored popup's content is built once, at presentation (see
/// `HudMenuController`), so nothing above it ever re-renders it, and a
/// `@Binding` does not invalidate a view on its own. Observing the two models
/// is what makes a switch answer the second tap as well as the first.
struct IndicatorSettingsView: View {
    @ObservedObject var chart: ChartViewModel
    @ObservedObject var chartTrading: ChartTradingCoordinator
    /// Closes this popup and raises the TWC script's own settings screen.
    let onOpenTwcSettings: () -> Void
    /// Closes the popup. The dropdown has no `dismiss` environment of its own:
    /// it is not presented by SwiftUI, it is drawn by `HudMenuLayer`.
    let onDismiss: () -> Void

    /// Wide enough for the longest switch row ("Dealer Gamma Flip Proxy") and
    /// for a stepper beside its own label; there is no shorter width that fits
    /// both, and the rows are the content rather than a list to be hugged.
    private static let width: CGFloat = 300
    /// Capped like the other popups are, and for the same reason: the form
    /// scrolls, so a panel tall enough to reach the trade panel buys nothing
    /// and hides the chart the settings are being judged against.
    private static let maxHeight: CGFloat = 440
    private static let rowHeight: CGFloat = 38

    private var settings: IndicatorSettingsState { chart.indicatorSettings }
    private var catalog: IndicatorControlCatalog {
        IndicatorControlCatalog(
            registry: chart.indicatorRegistry,
            hasL2Data: chart.hasFreshL2Data
        )
    }
    private var usesDefaultIndicators: Bool {
        settings == chart.defaultIndicatorSettings
            && chart.chartDisplayPreferences == .default
    }
    private var optionsAnalyticsSettings: OptionsAnalyticsSettings {
        chart.optionsAnalyticsSettings
    }
    private var chartTradingSettings: ChartTradingSettings { chartTrading.settings }

    /// Chart-trading settings are written through the coordinator rather than
    /// assigned: it is the coordinator that persists them.
    private var tradingBinding: Binding<ChartTradingSettings> {
        Binding(
            get: { chartTrading.settings },
            set: { chartTrading.updateSettings($0) }
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            separator
            ScrollView {
                LazyVStack(spacing: 0) {
                    priceOverlays
                    subPanes
                    scripts
                    chartTradingSection
                }
                .padding(.bottom, AppSpacing.sm)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .frame(width: Self.width)
        .frame(maxHeight: Self.maxHeight, alignment: .top)
        .animation(AppMotion.standard, value: settings)
        .sensoryFeedback(.selection, trigger: settings)
        .hudMenuPanel()
    }

    // MARK: - Chrome

    /// Title and Reset, on the row the ticker popup gives its search field, so
    /// the two dropdowns start at the same height.
    private var header: some View {
        HStack(spacing: AppSpacing.sm) {
            Text("INDICATORS")
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .kerning(0.8)
                .foregroundStyle(.secondary)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            Button("Reset") {
                Haptics.impact(.light)
                chart.resetIndicatorSettings()
                chart.setVolumeEnabled(ChartDisplayPreferences.default.volumeEnabled)
                chart.setVolumeWeightedCandleWidth(ChartDisplayPreferences.default.volumeWeightedCandleWidth)
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(Color.appAccent)
            .disabled(usesDefaultIndicators)
            Button {
                onDismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
            }
            .accessibilityLabel("Close indicator settings")
        }
        .padding(.horizontal, AppSpacing.md)
        .frame(height: 44)
    }

    private var separator: some View {
        Rectangle()
            .fill(Color.hudStroke.opacity(0.18))
            .frame(height: 1)
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.system(size: 9, weight: .bold, design: .monospaced))
            .kerning(0.8)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, AppSpacing.md)
            .padding(.top, AppSpacing.md)
            .padding(.bottom, AppSpacing.xs)
            .accessibilityAddTraits(.isHeader)
    }

    /// A switch row. `swatch` is the color dot keying the row to its chart line;
    /// `accessory` is the one row that carries a control of its own (the TWC
    /// script's gear).
    private func toggleRow(
        _ title: String,
        swatch: Color? = nil,
        isOn: Binding<Bool>,
        accessory: AnyView? = nil
    ) -> some View {
        Toggle(isOn: isOn) {
            HStack(spacing: AppSpacing.sm) {
                if let swatch {
                    Circle()
                        .fill(swatch)
                        .frame(width: 8, height: 8)
                        .accessibilityHidden(true)
                }
                Text(title)
                    .font(.subheadline)
                    .lineLimit(1)
                accessory
            }
        }
        .toggleStyle(.switch)
        .tint(.appAccent)
        .padding(.horizontal, AppSpacing.md)
        .frame(minHeight: Self.rowHeight)
    }

    /// A parameter row, indented under the switch that reveals it.
    private func stepperRow(
        descriptor: IndicatorParameterDescriptor,
        value: Binding<Double>
    ) -> some View {
        let step = descriptor.kind == .integer ? 1.0 : 0.1
        let formatted = descriptor.kind == .integer
            ? String(format: "%.0f", value.wrappedValue)
            : String(format: "%.1f", value.wrappedValue)
        return Stepper(
            value: value,
            in: descriptor.minimum...descriptor.maximum,
            step: step
        ) {
            Text("\(descriptor.label): \(formatted)")
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.leading, AppSpacing.md + AppSpacing.lg)
        .padding(.trailing, AppSpacing.md)
        .frame(minHeight: Self.rowHeight)
        .accessibilityLabel(descriptor.label)
        .accessibilityValue(formatted)
    }

    private func stepperRow(
        _ title: String,
        value: Binding<Int>,
        in range: ClosedRange<Int>,
        accessibilityLabel: String
    ) -> some View {
        Stepper(value: value, in: range) {
            Text(title)
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.leading, AppSpacing.md + AppSpacing.lg)
        .padding(.trailing, AppSpacing.md)
        .frame(minHeight: Self.rowHeight)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue("\(value.wrappedValue)")
    }

    /// A footnote under the rows it qualifies.
    private func note(_ text: String, tint: Color = .secondary) -> some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(tint)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, AppSpacing.md)
            .padding(.vertical, AppSpacing.xs)
    }

    // MARK: - Sections

    private var priceOverlays: some View {
        Group {
            sectionHeader("Price Overlays")
            ForEach(catalog.overlays) { control in
                indicatorControl(control)
            }
            toggleRow(
                "Volume",
                isOn: Binding(
                    get: { chart.chartDisplayPreferences.volumeEnabled },
                    set: { chart.setVolumeEnabled($0) }
                )
            )
            toggleRow(
                "Volume-Weighted Width",
                isOn: Binding(
                    get: { chart.chartDisplayPreferences.volumeWeightedCandleWidth },
                    set: { chart.setVolumeWeightedCandleWidth($0) }
                )
            )
        }
    }

    private var subPanes: some View {
        Group {
            sectionHeader("Sub-Panes")
            ForEach(catalog.subPanes) { control in
                indicatorControl(control)
            }
            if let message = chart.indicatorErrorMessage {
                note(message, tint: .appWarning)
            } else {
                note("Settings save automatically.")
            }
        }
    }

    @ViewBuilder
    private func indicatorControl(_ control: IndicatorControlItem) -> some View {
        let isEnabled = settings.indicators[control.id]?.enabled ?? false
        let firstToken = control.descriptor.geometry.series.first?.styleToken
        toggleRow(
            control.displayName,
            swatch: firstToken.map(ChartStyle.indicatorSwiftUIColor),
            isOn: Binding(
                get: { chart.indicatorSettings.indicators[control.id]?.enabled ?? false },
                set: { chart.setIndicatorEnabled(id: control.id, enabled: $0) }
            )
        )
        .disabled(!IndicatorTogglePolicy.canChange(
            availability: control.availability,
            isEnabled: isEnabled
        ))

        if control.availability == .noL2Data {
            note(chart.l2UnavailableReason)
        } else if isEnabled {
            ForEach(control.parameters.values.sorted { $0.id < $1.id }, id: \.id) { parameter in
                parameterControl(parameter, indicatorId: control.id)
            }
        }
    }

    @ViewBuilder
    private func parameterControl(
        _ descriptor: IndicatorParameterDescriptor,
        indicatorId: String
    ) -> some View {
        let binding = Binding<Double>(
            get: {
                chart.indicatorSettings.indicators[indicatorId]?.parameters[descriptor.id]
                    ?? descriptor.default
            },
            set: { chart.setIndicatorParameter(id: indicatorId, parameterId: descriptor.id, value: $0) }
        )
        if descriptor.kind == .timestamp {
            let sessionAnchor = binding.wrappedValue == 0 && descriptor.zeroMeansSessionAnchor == true
            VStack(alignment: .leading, spacing: AppSpacing.xs) {
                DatePicker(
                    descriptor.label,
                    selection: Binding(
                        get: {
                            sessionAnchor
                                ? Date()
                                : Date(timeIntervalSince1970: binding.wrappedValue / 1_000)
                        },
                        set: { binding.wrappedValue = ($0.timeIntervalSince1970 * 1_000).rounded() }
                    ),
                    displayedComponents: [.date, .hourAndMinute]
                )
                .font(.subheadline)
                if descriptor.zeroMeansSessionAnchor == true {
                    Button(sessionAnchor ? "Using current session" : "Use current session") {
                        binding.wrappedValue = 0
                    }
                    .font(.caption)
                    .foregroundStyle(Color.appAccent)
                    .disabled(sessionAnchor)
                }
            }
            .padding(.leading, AppSpacing.md + AppSpacing.lg)
            .padding(.trailing, AppSpacing.md)
            .padding(.vertical, AppSpacing.xs)
        } else {
            stepperRow(descriptor: descriptor, value: binding)
        }
    }

    private var scripts: some View {
        Group {
            sectionHeader("Scripts")
            toggleRow(
                "TWC Heatmap V5",
                isOn: $chart.twcSettings.enabled,
                accessory: AnyView(
                    Button {
                        onOpenTwcSettings()
                    } label: {
                        Image(systemName: "gearshape")
                            .font(.caption)
                            .foregroundStyle(Color.appAccent)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("TWC Heatmap V5 settings")
                )
            )

            toggleRow(
                "Options Structure",
                swatch: Color(OptionsAnalyticsPresentation.rangeColor),
                isOn: $chart.optionsAnalyticsSettings.enabled
            )
            if optionsAnalyticsSettings.enabled {
                let analytics = $chart.optionsAnalyticsSettings
                toggleRow("Implied 68% Range", isOn: analytics.showImpliedRange)
                toggleRow("Call / Put Gamma Profile", isOn: analytics.showGammaProfile)
                toggleRow("Marked OI", isOn: analytics.showMarkedOi)
                toggleRow("Liquidity", isOn: analytics.showLiquidity)
                toggleRow("Dealer Gamma Flip Proxy", isOn: analytics.showDealerProxy)
                if optionsAnalyticsSettings.showDealerProxy {
                    note("Scenario only. This is not observed dealer inventory.", tint: .appWarning)
                }
                toggleRow("Diagnostics & Quality Warnings", isOn: analytics.showDiagnostics)
                stepperRow(
                    "Profile Strikes: \(optionsAnalyticsSettings.profileStrikeCount)",
                    value: analytics.profileStrikeCount,
                    in: OptionsAnalyticsSettings.profileStrikeRange,
                    accessibilityLabel: "Options structure strike count"
                )
                Stepper(
                    value: analytics.refreshSeconds,
                    in: OptionsAnalyticsSettings.refreshRange,
                    step: 15
                ) {
                    Text("Refresh: \(optionsAnalyticsSettings.refreshSeconds)s")
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .padding(.leading, AppSpacing.md + AppSpacing.lg)
                .padding(.trailing, AppSpacing.md)
                .frame(minHeight: Self.rowHeight)
                .accessibilityLabel("Options structure refresh interval")
                .accessibilityValue("\(optionsAnalyticsSettings.refreshSeconds) seconds")
            }
        }
    }

    private var chartTradingSection: some View {
        Group {
            sectionHeader("Chart Trading")
            toggleRow(
                "Order Lines",
                swatch: .appAccent,
                isOn: tradingBinding.enabled
            )
            if chartTradingSettings.enabled {
                let trading = tradingBinding
                toggleRow("Bracket from Entry Line", isOn: trading.bracketDrag)
                stepperRow(
                    "Default Quantity: \(chartTradingSettings.defaultQuantity)",
                    value: trading.defaultQuantity,
                    in: ChartTradingSettings.defaultQuantityRange,
                    accessibilityLabel: "Chart trading default quantity"
                )
                note(
                    "Order lines are watched by 0dteTrader, not resting at the broker. "
                        + "A crossed level fires a mid or market order — tap MID/MKT on "
                        + "the line to switch.",
                    tint: .appWarning
                )
            }
        }
    }
}
