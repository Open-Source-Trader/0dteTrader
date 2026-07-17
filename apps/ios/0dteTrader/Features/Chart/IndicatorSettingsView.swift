import SwiftUI

/// Indicator toggles and parameters (PRD FR-7). Bound directly to the chart
/// view model's settings; changes persist via SettingsStore.
struct IndicatorSettingsView: View {
    @Binding var settings: IndicatorSettings
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Price Overlays") {
                    Toggle("SMA", isOn: $settings.smaEnabled)
                    if settings.smaEnabled {
                        Stepper("Period: \(settings.smaPeriod)", value: $settings.smaPeriod, in: 2...200)
                    }

                    Toggle("EMA", isOn: $settings.emaEnabled)
                    if settings.emaEnabled {
                        Stepper("Period: \(settings.emaPeriod)", value: $settings.emaPeriod, in: 2...200)
                    }

                    Toggle("VWAP", isOn: $settings.vwapEnabled)

                    Toggle("Bollinger Bands", isOn: $settings.bollingerEnabled)
                    if settings.bollingerEnabled {
                        Stepper("Period: \(settings.bollingerPeriod)", value: $settings.bollingerPeriod, in: 5...100)
                        Stepper(
                            "Width: \(Format.price(settings.bollingerMultiplier, fractionDigits: 1))σ",
                            value: $settings.bollingerMultiplier,
                            in: 0.5...4.0,
                            step: 0.5
                        )
                    }
                }

                Section("Sub-Panes") {
                    Toggle("RSI", isOn: $settings.rsiEnabled)
                    if settings.rsiEnabled {
                        Stepper("Period: \(settings.rsiPeriod)", value: $settings.rsiPeriod, in: 2...50)
                    }

                    Toggle("MACD (12, 26, 9)", isOn: $settings.macdEnabled)
                }
            }
            .navigationTitle("Indicators")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
