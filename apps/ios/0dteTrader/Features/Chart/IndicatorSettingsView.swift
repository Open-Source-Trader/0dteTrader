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

    private var settings: IndicatorSettings { chart.indicatorSettings }
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
                chart.indicatorSettings = .default
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(Color.appAccent)
            .disabled(settings == .default)
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
            toggleRow(
                "SMA",
                swatch: ChartStyle.overlayColor(for: "sma"),
                isOn: $chart.indicatorSettings.smaEnabled
            )
            if settings.smaEnabled {
                stepperRow(
                    "Period: \(settings.smaPeriod)",
                    value: $chart.indicatorSettings.smaPeriod,
                    in: IndicatorSettings.maPeriodRange,
                    accessibilityLabel: "SMA period"
                )
            }

            toggleRow(
                "EMA",
                swatch: ChartStyle.overlayColor(for: "ema"),
                isOn: $chart.indicatorSettings.emaEnabled
            )
            if settings.emaEnabled {
                stepperRow(
                    "Period: \(settings.emaPeriod)",
                    value: $chart.indicatorSettings.emaPeriod,
                    in: IndicatorSettings.maPeriodRange,
                    accessibilityLabel: "EMA period"
                )
            }

            toggleRow(
                "VWAP",
                swatch: ChartStyle.overlayColor(for: "vwap"),
                isOn: $chart.indicatorSettings.vwapEnabled
            )
            toggleRow("Volume", isOn: $chart.indicatorSettings.volumeEnabled)
            toggleRow(
                "Bollinger Bands",
                isOn: $chart.indicatorSettings.bollingerEnabled
            )
            if settings.bollingerEnabled {
                stepperRow(
                    "Period: \(settings.bollingerPeriod)",
                    value: $chart.indicatorSettings.bollingerPeriod,
                    in: IndicatorSettings.bollingerPeriodRange,
                    accessibilityLabel: "Bollinger Bands period"
                )
                // Unitless sigma multiplier — Format.price is for prices/P&L.
                // NOTE: belongs in DesignSystem as `Format.multiplier`; the
                // foundation is frozen for this pass.
                Stepper(
                    value: $chart.indicatorSettings.bollingerMultiplier,
                    in: IndicatorSettings.bollingerMultiplierRange,
                    step: 0.5
                ) {
                    Text("Width: \(String(format: "%.1f", settings.bollingerMultiplier))σ")
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .padding(.leading, AppSpacing.md + AppSpacing.lg)
                .padding(.trailing, AppSpacing.md)
                .frame(minHeight: Self.rowHeight)
                .accessibilityLabel("Bollinger Bands width")
                .accessibilityValue("\(String(format: "%.1f", settings.bollingerMultiplier)) sigma")
            }
        }
    }

    private var subPanes: some View {
        Group {
            sectionHeader("Sub-Panes")
            toggleRow("RSI", isOn: $chart.indicatorSettings.rsiEnabled)
            if settings.rsiEnabled {
                stepperRow(
                    "Period: \(settings.rsiPeriod)",
                    value: $chart.indicatorSettings.rsiPeriod,
                    in: IndicatorSettings.oscillatorPeriodRange,
                    accessibilityLabel: "RSI period"
                )
            }

            toggleRow("MACD", isOn: $chart.indicatorSettings.macdEnabled)
            toggleRow("Stochastic", isOn: $chart.indicatorSettings.stochEnabled)
            if settings.stochEnabled {
                stepperRow(
                    "%K Period: \(settings.stochKPeriod)",
                    value: $chart.indicatorSettings.stochKPeriod,
                    in: IndicatorSettings.stochKPeriodRange,
                    accessibilityLabel: "Stochastic %K period"
                )
                stepperRow(
                    "%K Smoothing: \(settings.stochKSmooth)",
                    value: $chart.indicatorSettings.stochKSmooth,
                    in: IndicatorSettings.stochSmoothRange,
                    accessibilityLabel: "Stochastic %K smoothing"
                )
                stepperRow(
                    "%D Period: \(settings.stochDPeriod)",
                    value: $chart.indicatorSettings.stochDPeriod,
                    in: IndicatorSettings.stochSmoothRange,
                    accessibilityLabel: "Stochastic %D period"
                )
            }

            toggleRow("ATR", isOn: $chart.indicatorSettings.atrEnabled)
            if settings.atrEnabled {
                stepperRow(
                    "Period: \(settings.atrPeriod)",
                    value: $chart.indicatorSettings.atrPeriod,
                    in: IndicatorSettings.oscillatorPeriodRange,
                    accessibilityLabel: "ATR period"
                )
            }
            note("MACD uses standard 12 / 26 / 9 parameters. Settings save automatically.")
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
