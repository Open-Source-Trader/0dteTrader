import SwiftUI

struct UsrSettingsView: View {
    @Binding var settings: UsrSettings
    @State private var draft: UsrSettings

    private static let colorFields: [WritableKeyPath<UsrSettings, String>] = [
        \.fvgBullishColor, \.fvgBearishColor, \.fvgCeColor,
        \.ifvgBullishColor, \.ifvgBearishColor
    ]

    init(settings: Binding<UsrSettings>) {
        _settings = settings
        _draft = State(initialValue: settings.wrappedValue)
    }

    /// Text fields must permit intermediate invalid input without disabling the
    /// live indicator. Commit every independently valid change while retaining
    /// the last persisted value for only the malformed text field.
    private func commitValidFields(from candidate: UsrSettings) {
        var committed = candidate
        if UsrTimeframe.parse(candidate.customTimeframe) == nil {
            committed.customTimeframe = settings.customTimeframe
        }
        for keyPath in Self.colorFields where !ScriptColor.isValid(candidate[keyPath: keyPath]) {
            committed[keyPath: keyPath] = settings[keyPath: keyPath]
        }
        if committed.isValid { settings = committed }
    }

    private func bool(_ keyPath: WritableKeyPath<UsrSettings, Bool>) -> Binding<Bool> {
        Binding(get: { draft[keyPath: keyPath] }, set: { draft[keyPath: keyPath] = $0 })
    }

    private func int(
        _ keyPath: WritableKeyPath<UsrSettings, Int>,
        _ range: ClosedRange<Int>
    ) -> Binding<Int> {
        Binding(
            get: { draft[keyPath: keyPath] },
            set: { draft[keyPath: keyPath] = min(range.upperBound, max(range.lowerBound, $0)) }
        )
    }

    private func double(
        _ keyPath: WritableKeyPath<UsrSettings, Double>,
        _ range: ClosedRange<Double>
    ) -> Binding<Double> {
        Binding(
            get: { draft[keyPath: keyPath] },
            set: { draft[keyPath: keyPath] = min(range.upperBound, max(range.lowerBound, $0)) }
        )
    }

    private func stepper(
        _ title: String,
        _ keyPath: WritableKeyPath<UsrSettings, Int>,
        _ range: ClosedRange<Int>,
        step: Int = 1
    ) -> some View {
        Stepper("\(title): \(draft[keyPath: keyPath])", value: int(keyPath, range), in: range, step: step)
    }

    private func decimal(
        _ title: String,
        _ keyPath: WritableKeyPath<UsrSettings, Double>,
        _ range: ClosedRange<Double>,
        step: Double
    ) -> some View {
        let format = step < 0.001 ? "%.6f" : step < 0.1 ? "%.2f" : "%.1f"
        let formatted = String(format: format, draft[keyPath: keyPath])
        return Stepper(
            "\(title): \(formatted)",
            value: double(keyPath, range), in: range, step: step
        )
    }

    var body: some View {
        Form {
            Section("Analysis") {
                Picker("Timeframe", selection: $draft.analysisTimeframe) {
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
                if draft.analysisTimeframe == "custom" {
                    TextField("Custom timeframe", text: $draft.customTimeframe)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                }
                Toggle("Session-aware Volume", isOn: bool(\.sessionAwareVolume))
                stepper("Volume lookback", \.volumeLookback, UsrSettingsBounds.volumeLookback)
                decimal("Relative volume", \.minimumRelativeVolume, UsrSettingsBounds.minimumRelativeVolume, step: 0.05)
                decimal("Volume Z-score", \.minimumVolumeZScore, UsrSettingsBounds.minimumVolumeZScore, step: 0.25)
                stepper("Sequence maximum", \.maxSequenceLength, UsrSettingsBounds.maxSequenceLength)
            }
            Section("Structure") {
                decimal("Displacement body %", \.displacementBodyPercent, UsrSettingsBounds.displacementBodyPercent, step: 5)
                decimal("Displacement ATR", \.displacementAtrMultiplier, UsrSettingsBounds.displacementAtrMultiplier, step: 0.05)
                stepper("Structure lookback", \.structureLookback, UsrSettingsBounds.structureLookback)
                stepper("Pivot left", \.pivotLeftBars, UsrSettingsBounds.pivotLeftBars)
                stepper("Pivot right", \.pivotRightBars, UsrSettingsBounds.pivotRightBars)
                Toggle("Order Blocks Use Wicks", isOn: bool(\.orderBlockUseWicks))
                decimal("Gap ATR", \.gapAtrMultiplier, UsrSettingsBounds.gapAtrMultiplier, step: 0.05)
                Toggle("Require True Price Voids", isOn: bool(\.requirePriceVoidGaps))
                stepper("Break buffer ticks", \.breakBufferTicks, UsrSettingsBounds.breakBufferTicks)
                decimal("Mitigation fraction", \.zoneMitigationPercent, UsrSettingsBounds.zoneMitigationPercent, step: 0.05)
                decimal("Instrument minimum tick", \.minimumTick, UsrSettingsBounds.minimumTick, step: 0.000_001)
            }
            Section("Levels & Derived Areas") {
                Toggle("Price Proximity Filter", isOn: bool(\.enableProximityFilter))
                decimal("Proximity %", \.proximityPercent, UsrSettingsBounds.proximityPercent, step: 1)
                stepper("Support retention", \.maxSupportLevels, UsrSettingsBounds.maxSupportLevels)
                stepper("Resistance retention", \.maxResistanceLevels, UsrSettingsBounds.maxResistanceLevels)
                Toggle("S/R Flips", isOn: bool(\.enableSrFlip))
                Toggle("Show Flipped Origins", isOn: bool(\.showFlippedOrigins))
                Toggle("Show All Broken", isOn: bool(\.showAllBrokenLevels))
                Toggle("Confluence Areas", isOn: bool(\.showConfluence))
                Toggle("Liquidity Pools", isOn: bool(\.showLiquidityPools))
                Toggle("Hide Pooled Lines", isOn: bool(\.hidePooledLines))
                stepper("Pool minimum levels", \.poolClusterThreshold, UsrSettingsBounds.poolClusterThreshold)
                decimal("Pool ATR factor", \.poolAtrFactor, UsrSettingsBounds.poolAtrFactor, step: 0.1)
                stepper("Support pools", \.maxSupportPools, UsrSettingsBounds.maxSupportPools)
                stepper("Resistance pools", \.maxResistancePools, UsrSettingsBounds.maxResistancePools)
            }
            Section("Fair Value Gaps") {
                Toggle("FVGs", isOn: bool(\.showFvg))
                Toggle("Inverse FVGs", isOn: bool(\.showIfvg))
                Toggle("Consequent Encroachment", isOn: bool(\.showFvgCe))
                Toggle("Labels", isOn: bool(\.showFvgLabels))
                Picker("Fill milestone", selection: $draft.fvgFillMode) {
                    Text("Touch").tag("touch")
                    Text("Close inside").tag("close")
                    Text("50% CE").tag("ce")
                    Text("Custom %").tag("percent")
                }
                decimal("Fill %", \.fvgFillPercent, UsrSettingsBounds.fvgFillPercent, step: 5)
                stepper("Body lookback", \.fvgLookback, UsrSettingsBounds.fvgLookback)
                decimal("Body factor", \.fvgBodyPercent, UsrSettingsBounds.fvgBodyPercent, step: 0.01)
                decimal("Wick factor", \.fvgWickPercent, UsrSettingsBounds.fvgWickPercent, step: 0.05)
                stepper("Visible per side", \.maxVisibleFvgs, UsrSettingsBounds.maxVisibleFvgs)
                stepper("Maximum age", \.fvgMaxBarsActive, UsrSettingsBounds.fvgMaxBarsActive)
                decimal("Minimum gap ATR", \.fvgMinGapAtr, UsrSettingsBounds.fvgMinGapAtr, step: 0.01)
                decimal("Minimum body ATR", \.fvgMinBodyAtr, UsrSettingsBounds.fvgMinBodyAtr, step: 0.05)
                TextField("Bullish FVG color", text: $draft.fvgBullishColor)
                TextField("Bearish FVG color", text: $draft.fvgBearishColor)
                TextField("FVG CE color", text: $draft.fvgCeColor)
                TextField("Bullish IFVG color", text: $draft.ifvgBullishColor)
                TextField("Bearish IFVG color", text: $draft.ifvgBearishColor)
                if !draft.isValid {
                    Text("Invalid timeframe or color. The last valid value remains active.")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            Section("Signals") {
                Toggle("Bounce Signals", isOn: bool(\.showBounceSignals))
                Toggle("Sweep Signals", isOn: bool(\.showSweepSignals))
                Toggle("Wick or Volume Qualification", isOn: bool(\.signalRequireQualification))
                Toggle("Confirmation Direction", isOn: bool(\.requireConfirmationCandleDirection))
                Toggle("Cancel Nearby Opposing", isOn: bool(\.cancelOpposingSignal))
                stepper("Recent markers", \.maxRecentSignalsTotal, UsrSettingsBounds.maxRecentSignalsTotal)
            }
            Section {
                Button("Reset Ultimate S/R", role: .destructive) {
                    let enabled = draft.enabled
                    draft = .default
                    draft.enabled = enabled
                }
            }
        }
        .navigationTitle("Ultimate S/R")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: draft) { _, candidate in
            commitValidFields(from: candidate)
        }
    }
}
