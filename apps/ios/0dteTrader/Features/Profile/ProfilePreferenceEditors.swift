import SwiftUI

struct IVAlertDetectionEditor: View {
    let configuration: IVAlertConfigurationStateDTO
    let disabled: Bool
    let onSave: (IVAlertConfigurationDTO) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.xs) {
            Stepper(
                "Lookback \(configuration.lookbackMinutes) min",
                value: binding(\.lookbackMinutes),
                in: 5...240,
                step: 5
            )
            Stepper(
                value: Binding(
                    get: { configuration.thresholdK },
                    set: { save(thresholdK: $0) }
                ),
                in: 0.1...20,
                step: 0.1
            ) {
                Text("Threshold k \(configuration.thresholdK, specifier: "%.1f")")
            }
            Stepper(
                "Consecutive breaches \(configuration.consecutiveBreaches)",
                value: binding(\.consecutiveBreaches),
                in: 1...10
            )
            Stepper(
                "Warmup \(configuration.warmupMinutes) min",
                value: binding(\.warmupMinutes),
                in: 0...60
            )
            Stepper(
                "Warmup samples \(configuration.warmupSamples)",
                value: binding(\.warmupSamples),
                in: 1...240
            )
            Stepper(
                "Cooldown \(configuration.cooldownMinutes) min",
                value: binding(\.cooldownMinutes),
                in: 0...1_440,
                step: 5
            )
        }
        .font(.caption)
        .disabled(disabled)
        .accessibilityElement(children: .contain)
    }

    private func binding(_ keyPath: KeyPath<IVAlertConfigurationStateDTO, Int>) -> Binding<Int> {
        Binding(
            get: { configuration[keyPath: keyPath] },
            set: { value in
                switch keyPath {
                case \IVAlertConfigurationStateDTO.lookbackMinutes: save(lookbackMinutes: value)
                case \IVAlertConfigurationStateDTO.consecutiveBreaches: save(consecutiveBreaches: value)
                case \IVAlertConfigurationStateDTO.warmupMinutes: save(warmupMinutes: value)
                case \IVAlertConfigurationStateDTO.warmupSamples: save(warmupSamples: value)
                case \IVAlertConfigurationStateDTO.cooldownMinutes: save(cooldownMinutes: value)
                default: break
                }
            }
        )
    }

    private func save(
        lookbackMinutes: Int? = nil,
        thresholdK: Double? = nil,
        consecutiveBreaches: Int? = nil,
        warmupMinutes: Int? = nil,
        warmupSamples: Int? = nil,
        cooldownMinutes: Int? = nil
    ) {
        onSave(IVAlertConfigurationDTO(
            enabled: configuration.enabled,
            symbols: configuration.symbols,
            lookbackMinutes: lookbackMinutes ?? configuration.lookbackMinutes,
            thresholdK: thresholdK ?? configuration.thresholdK,
            consecutiveBreaches: consecutiveBreaches ?? configuration.consecutiveBreaches,
            warmupMinutes: warmupMinutes ?? configuration.warmupMinutes,
            warmupSamples: warmupSamples ?? configuration.warmupSamples,
            cooldownMinutes: cooldownMinutes ?? configuration.cooldownMinutes
        ))
    }
}

struct AutoScoringCustomEditor: View {
    private struct Draft {
        var targetAbsDelta: Double
        var strikeRungs: Int
        var maxSpreadBps: Double
        var maxPremiumDollars: Double
        var minOpenInterest: Int
        var gammaMode: AutoScoringGammaMode
        var deltaWeight: Double
        var spreadWeight: Double
        var openInterestWeight: Double
        var gammaWeight: Double
        var ivWeight: Double

        init(_ record: AutoScoringPreferenceRecord) {
            targetAbsDelta = record.targetAbsDelta
            strikeRungs = record.strikeRungs
            maxSpreadBps = record.maxSpreadBps
            maxPremiumDollars = record.maxPremiumDollars
            minOpenInterest = record.minOpenInterest
            gammaMode = record.gammaMode
            deltaWeight = record.deltaWeight
            spreadWeight = record.spreadWeight
            openInterestWeight = record.openInterestWeight
            gammaWeight = record.gammaWeight
            ivWeight = record.ivWeight
        }

        var preferences: AutoScoringPreferences {
            AutoScoringPreferences(
                schemaVersion: 1,
                preset: .custom,
                targetAbsDelta: targetAbsDelta,
                strikeRungs: strikeRungs,
                maxSpreadBps: maxSpreadBps,
                maxPremiumDollars: maxPremiumDollars,
                minOpenInterest: minOpenInterest,
                gammaMode: gammaMode,
                weights: AutoScoringWeights(
                    delta: deltaWeight,
                    spread: spreadWeight,
                    openInterest: openInterestWeight,
                    gamma: gammaWeight,
                    iv: ivWeight
                )
            )
        }

        var hasPositiveWeight: Bool {
            deltaWeight + spreadWeight + openInterestWeight + gammaWeight + ivWeight > 0
        }
    }

    @State private var draft: Draft
    let busy: Bool
    let onSave: (AutoScoringPreferences) -> Void

    init(
        preference: AutoScoringPreferenceRecord,
        busy: Bool,
        onSave: @escaping (AutoScoringPreferences) -> Void
    ) {
        _draft = State(initialValue: Draft(preference))
        self.busy = busy
        self.onSave = onSave
    }

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.xs) {
            Text("Custom settings")
                .font(.caption.weight(.semibold))
            Stepper(value: $draft.targetAbsDelta, in: 0.01...0.99, step: 0.01) {
                Text("Target |delta| \(draft.targetAbsDelta, specifier: "%.2f")")
            }
            Stepper("Strike rungs \(draft.strikeRungs)", value: $draft.strikeRungs, in: 0...20)
            Stepper(value: $draft.maxSpreadBps, in: 0...10_000, step: 25) {
                Text("Maximum spread \(draft.maxSpreadBps, specifier: "%.0f") bps")
            }
            Stepper(value: $draft.maxPremiumDollars, in: 1...1_000_000, step: 25) {
                Text("Maximum premium $\(draft.maxPremiumDollars, specifier: "%.0f")")
            }
            Stepper(
                "Minimum open interest \(draft.minOpenInterest)",
                value: $draft.minOpenInterest,
                in: 0...1_000_000_000,
                step: 25
            )
            Picker("Gamma preference", selection: $draft.gammaMode) {
                Text("Avoid gamma").tag(AutoScoringGammaMode.avoid)
                Text("Seek gamma").tag(AutoScoringGammaMode.seek)
            }
            .pickerStyle(.segmented)
            weightRow("Delta weight", value: $draft.deltaWeight)
            weightRow("Spread weight", value: $draft.spreadWeight)
            weightRow("Open interest weight", value: $draft.openInterestWeight)
            weightRow("Gamma weight", value: $draft.gammaWeight)
            weightRow("IV weight", value: $draft.ivWeight)
            Button("Save custom settings") { onSave(draft.preferences) }
                .buttonStyle(.borderedProminent)
                .disabled(busy || !draft.hasPositiveWeight)
                .accessibilityHint("Saves these settings with optimistic concurrency validation")
        }
        .font(.caption)
        .disabled(busy)
        .accessibilityElement(children: .contain)
    }

    private func weightRow(_ label: String, value: Binding<Double>) -> some View {
        Stepper(value: value, in: 0...1, step: 0.05) {
            Text("\(label) \(value.wrappedValue, specifier: "%.2f")")
        }
    }
}
