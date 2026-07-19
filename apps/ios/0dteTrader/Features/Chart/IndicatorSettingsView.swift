import SwiftUI

/// Indicator toggles and parameters (PRD FR-7). Bound directly to the chart
/// view model's settings; changes persist via SettingsStore.
struct IndicatorSettingsView: View {
    @Binding var settings: IndicatorSettings
    @Binding var twcSettings: TwcHeatmapSettings
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Price Overlays") {
                    Toggle(isOn: $settings.smaEnabled) {
                        labelWithSwatch("SMA", id: "sma")
                    }
                    if settings.smaEnabled {
                        Stepper("Period: \(settings.smaPeriod)",
                                value: $settings.smaPeriod,
                                in: IndicatorSettings.maPeriodRange)
                            .monospacedDigit()
                            .accessibilityLabel("SMA period")
                            .accessibilityValue("\(settings.smaPeriod)")
                    }

                    Toggle(isOn: $settings.emaEnabled) {
                        labelWithSwatch("EMA", id: "ema")
                    }
                    if settings.emaEnabled {
                        Stepper("Period: \(settings.emaPeriod)",
                                value: $settings.emaPeriod,
                                in: IndicatorSettings.maPeriodRange)
                            .monospacedDigit()
                            .accessibilityLabel("EMA period")
                            .accessibilityValue("\(settings.emaPeriod)")
                    }

                    Toggle(isOn: $settings.vwapEnabled) {
                        labelWithSwatch("VWAP", id: "vwap")
                    }

                    Toggle("Volume", isOn: $settings.volumeEnabled)

                    Toggle("Bollinger Bands", isOn: $settings.bollingerEnabled)
                    if settings.bollingerEnabled {
                        Stepper("Period: \(settings.bollingerPeriod)",
                                value: $settings.bollingerPeriod,
                                in: IndicatorSettings.bollingerPeriodRange)
                            .monospacedDigit()
                            .accessibilityLabel("Bollinger Bands period")
                            .accessibilityValue("\(settings.bollingerPeriod)")
                        // Unitless sigma multiplier — Format.price is for prices/P&L.
                        // NOTE: belongs in DesignSystem as `Format.multiplier`; the
                        // foundation is frozen for this pass.
                        Stepper("Width: \(String(format: "%.1f", settings.bollingerMultiplier))σ",
                                value: $settings.bollingerMultiplier,
                                in: IndicatorSettings.bollingerMultiplierRange,
                                step: 0.5)
                            .monospacedDigit()
                            .accessibilityLabel("Bollinger Bands width")
                            .accessibilityValue("\(String(format: "%.1f", settings.bollingerMultiplier)) sigma")
                    }
                }
                .listRowBackground(Color.appSurface)

                Section("Sub-Panes") {
                    Toggle("RSI", isOn: $settings.rsiEnabled)
                    if settings.rsiEnabled {
                        Stepper("Period: \(settings.rsiPeriod)",
                                value: $settings.rsiPeriod,
                                in: IndicatorSettings.oscillatorPeriodRange)
                            .monospacedDigit()
                            .accessibilityLabel("RSI period")
                            .accessibilityValue("\(settings.rsiPeriod)")
                    }

                    Toggle("MACD", isOn: $settings.macdEnabled)

                    Toggle("Stochastic", isOn: $settings.stochEnabled)
                    if settings.stochEnabled {
                        Stepper("%K Period: \(settings.stochKPeriod)",
                                value: $settings.stochKPeriod,
                                in: IndicatorSettings.stochKPeriodRange)
                            .monospacedDigit()
                            .accessibilityLabel("Stochastic %K period")
                            .accessibilityValue("\(settings.stochKPeriod)")
                        Stepper("%K Smoothing: \(settings.stochKSmooth)",
                                value: $settings.stochKSmooth,
                                in: IndicatorSettings.stochSmoothRange)
                            .monospacedDigit()
                            .accessibilityLabel("Stochastic %K smoothing")
                            .accessibilityValue("\(settings.stochKSmooth)")
                        Stepper("%D Period: \(settings.stochDPeriod)",
                                value: $settings.stochDPeriod,
                                in: IndicatorSettings.stochSmoothRange)
                            .monospacedDigit()
                            .accessibilityLabel("Stochastic %D period")
                            .accessibilityValue("\(settings.stochDPeriod)")
                    }

                    Toggle("ATR", isOn: $settings.atrEnabled)
                    if settings.atrEnabled {
                        Stepper("Period: \(settings.atrPeriod)",
                                value: $settings.atrPeriod,
                                in: IndicatorSettings.oscillatorPeriodRange)
                            .monospacedDigit()
                            .accessibilityLabel("ATR period")
                            .accessibilityValue("\(settings.atrPeriod)")
                    }
                } footer: {
                    Text("MACD uses standard 12 / 26 / 9 parameters. Settings save automatically.")
                }
                .listRowBackground(Color.appSurface)

                Section("Scripts") {
                    HStack(spacing: AppSpacing.sm) {
                        Toggle(isOn: $twcSettings.enabled) {
                            Text("TWC Heatmap V5")
                        }
                        NavigationLink {
                            TwcSettingsView(settings: $twcSettings)
                        } label: {
                            Image(systemName: "gearshape")
                                .foregroundStyle(Color.appAccent)
                        }
                        .fixedSize()
                        .accessibilityLabel("TWC Heatmap V5 settings")
                    }
                }
                .listRowBackground(Color.appSurface)
            }
            .tint(.appAccent)
            .scrollContentBackground(.hidden)
            .background(Color.appBackground)
            .animation(AppMotion.standard, value: settings)
            .sensoryFeedback(.selection, trigger: settings)
            .navigationTitle("Indicators")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Reset") { settings = .default }
                        .disabled(settings == .default)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    /// Toggle label with a color dot keying it to the chart's line color.
    private func labelWithSwatch(_ title: String, id: String) -> some View {
        HStack(spacing: AppSpacing.sm) {
            Circle()
                .fill(ChartStyle.overlayColor(for: id))
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)
            Text(title)
        }
    }
}
