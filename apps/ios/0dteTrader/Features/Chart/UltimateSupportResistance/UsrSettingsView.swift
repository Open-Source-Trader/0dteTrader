import SwiftUI

struct UsrSettingsView: View {
    @Binding var settings: UsrSettings

    private func bool(_ keyPath: WritableKeyPath<UsrSettings, Bool>) -> Binding<Bool> {
        Binding(get: { settings[keyPath: keyPath] }, set: { settings[keyPath: keyPath] = $0 })
    }

    private func int(
        _ keyPath: WritableKeyPath<UsrSettings, Int>,
        _ range: ClosedRange<Int>
    ) -> Binding<Int> {
        Binding(
            get: { settings[keyPath: keyPath] },
            set: { settings[keyPath: keyPath] = min(range.upperBound, max(range.lowerBound, $0)) }
        )
    }

    private func double(
        _ keyPath: WritableKeyPath<UsrSettings, Double>,
        _ range: ClosedRange<Double>
    ) -> Binding<Double> {
        Binding(
            get: { settings[keyPath: keyPath] },
            set: { settings[keyPath: keyPath] = min(range.upperBound, max(range.lowerBound, $0)) }
        )
    }

    private func stepper(
        _ title: String,
        _ keyPath: WritableKeyPath<UsrSettings, Int>,
        _ range: ClosedRange<Int>,
        step: Int = 1
    ) -> some View {
        Stepper("\(title): \(settings[keyPath: keyPath])", value: int(keyPath, range), in: range, step: step)
    }

    private func decimal(
        _ title: String,
        _ keyPath: WritableKeyPath<UsrSettings, Double>,
        _ range: ClosedRange<Double>,
        step: Double
    ) -> some View {
        let format = step < 0.001 ? "%.6f" : step < 0.1 ? "%.2f" : "%.1f"
        let formatted = String(format: format, settings[keyPath: keyPath])
        return Stepper(
            "\(title): \(formatted)",
            value: double(keyPath, range), in: range, step: step
        )
    }

    var body: some View {
        Form {
            Section("Analysis") {
                Picker("Timeframe", selection: $settings.analysisTimeframe) {
                    Text("Chart").tag("chart")
                    Text("Auto").tag("auto")
                    Text("4 hours").tag("4h")
                    Text("1 day").tag("1d")
                    Text("3 days").tag("3d")
                    Text("1 week").tag("1w")
                    Text("2 weeks").tag("2w")
                    Text("1 month").tag("1m")
                    Text("Custom").tag("custom")
                }
                if settings.analysisTimeframe == "custom" {
                    TextField("Custom timeframe", text: $settings.customTimeframe)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                }
                Toggle("Session-aware Volume", isOn: bool(\.sessionAwareVolume))
                stepper("Volume lookback", \.volumeLookback, 10...200)
                decimal("Relative volume", \.minimumRelativeVolume, 1...5, step: 0.05)
                decimal("Volume Z-score", \.minimumVolumeZScore, 0...5, step: 0.25)
                stepper("Sequence maximum", \.maxSequenceLength, 2...50)
            }
            Section("Structure") {
                decimal("Displacement body %", \.displacementBodyPercent, 40...95, step: 5)
                decimal("Displacement ATR", \.displacementAtrMultiplier, 0.2...3, step: 0.05)
                stepper("Structure lookback", \.structureLookback, 2...20)
                stepper("Pivot left", \.pivotLeftBars, 1...10)
                stepper("Pivot right", \.pivotRightBars, 1...5)
                Toggle("Order Blocks Use Wicks", isOn: bool(\.orderBlockUseWicks))
                decimal("Gap ATR", \.gapAtrMultiplier, 0.05...3, step: 0.05)
                Toggle("Require True Price Voids", isOn: bool(\.requirePriceVoidGaps))
                stepper("Break buffer ticks", \.breakBufferTicks, 1...20)
                decimal("Mitigation fraction", \.zoneMitigationPercent, 0.5...1, step: 0.05)
                decimal("Instrument minimum tick", \.minimumTick, 0.000_001...100, step: 0.000_001)
            }
            Section("Levels & Derived Areas") {
                Toggle("Price Proximity Filter", isOn: bool(\.enableProximityFilter))
                decimal("Proximity %", \.proximityPercent, 1...50, step: 1)
                stepper("Support retention", \.maxSupportLevels, 1...500)
                stepper("Resistance retention", \.maxResistanceLevels, 1...500)
                Toggle("S/R Flips", isOn: bool(\.enableSrFlip))
                Toggle("Show Flipped Origins", isOn: bool(\.showFlippedOrigins))
                Toggle("Show All Broken", isOn: bool(\.showAllBrokenLevels))
                Toggle("Confluence Areas", isOn: bool(\.showConfluence))
                Toggle("Liquidity Pools", isOn: bool(\.showLiquidityPools))
                Toggle("Hide Pooled Lines", isOn: bool(\.hidePooledLines))
                stepper("Pool minimum levels", \.poolClusterThreshold, 2...10)
                decimal("Pool ATR factor", \.poolAtrFactor, 1...5, step: 0.1)
                stepper("Support pools", \.maxSupportPools, 1...60)
                stepper("Resistance pools", \.maxResistancePools, 1...60)
            }
            Section("Fair Value Gaps") {
                Toggle("FVGs", isOn: bool(\.showFvg))
                Toggle("Inverse FVGs", isOn: bool(\.showIfvg))
                Toggle("Consequent Encroachment", isOn: bool(\.showFvgCe))
                Toggle("Labels", isOn: bool(\.showFvgLabels))
                Picker("Fill milestone", selection: $settings.fvgFillMode) {
                    Text("Touch").tag("touch")
                    Text("Close inside").tag("close")
                    Text("50% CE").tag("ce")
                    Text("Custom %").tag("percent")
                }
                decimal("Fill %", \.fvgFillPercent, 10...100, step: 5)
                stepper("Body lookback", \.fvgLookback, 3...50)
                decimal("Body factor", \.fvgBodyPercent, 0.05...3, step: 0.01)
                decimal("Wick factor", \.fvgWickPercent, 0...2, step: 0.05)
                stepper("Visible per side", \.maxVisibleFvgs, 1...15)
                stepper("Maximum age", \.fvgMaxBarsActive, 10...500)
                decimal("Minimum gap ATR", \.fvgMinGapAtr, 0...1, step: 0.01)
                decimal("Minimum body ATR", \.fvgMinBodyAtr, 0...3, step: 0.05)
                TextField("Bullish FVG color", text: $settings.fvgBullishColor)
                TextField("Bearish FVG color", text: $settings.fvgBearishColor)
                TextField("FVG CE color", text: $settings.fvgCeColor)
                TextField("Bullish IFVG color", text: $settings.ifvgBullishColor)
                TextField("Bearish IFVG color", text: $settings.ifvgBearishColor)
            }
            Section("Signals") {
                Toggle("Bounce Signals", isOn: bool(\.showBounceSignals))
                Toggle("Sweep Signals", isOn: bool(\.showSweepSignals))
                Toggle("Wick or Volume Qualification", isOn: bool(\.signalRequireQualification))
                Toggle("Confirmation Direction", isOn: bool(\.requireConfirmationCandleDirection))
                Toggle("Cancel Nearby Opposing", isOn: bool(\.cancelOpposingSignal))
                stepper("Recent markers", \.maxRecentSignalsTotal, 5...100)
            }
            Section {
                Button("Reset Ultimate S/R", role: .destructive) {
                    let enabled = settings.enabled
                    settings = .default
                    settings.enabled = enabled
                }
            }
        }
        .navigationTitle("Ultimate S/R")
        .navigationBarTitleDisplayMode(.inline)
    }
}
