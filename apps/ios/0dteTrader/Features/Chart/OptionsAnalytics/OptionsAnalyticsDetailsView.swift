import SwiftUI

struct OptionsAnalyticsDetailsView: View {
    let snapshot: OptionsAnalyticsSnapshotDTO
    let settings: OptionsAnalyticsSettings

    var body: some View {
        NavigationStack {
            List {
                Section("Snapshot") {
                    row("Symbol / expiry", "\(snapshot.scope.symbol) · \(snapshot.scope.expiration)")
                    row(
                        "Root / settlement style",
                        "\(snapshot.scope.rootSymbol) · \(snapshot.scope.settlementStyle.rawValue.uppercased())"
                    )
                    row("Spot / forward", "\(Format.price(snapshot.scope.spot)) · \(Format.price(snapshot.scope.forward))")
                    row("Observed", age(snapshot.scope.observedAt))
                    row("Quote", age(snapshot.quality.quoteAsOf))
                    row("Greeks", age(snapshot.quality.greeksAsOf))
                    row("OI effective", snapshot.quality.oiEffectiveDate ?? "Unavailable")
                    row("Settlement", snapshot.scope.settlementAt)
                }
                Section("Method and quality") {
                    Text(snapshot.exposureUnit)
                    row("Feed", snapshot.quality.feedMode.rawValue)
                    row(
                        "Coverage",
                        "\(snapshot.quality.coverage.contractsIncluded) / "
                            + "\(snapshot.quality.coverage.contractsTotal) · "
                            + "\(Int((snapshot.quality.coverage.ratio * 100).rounded()))%"
                    )
                    row(
                        "Status / cache",
                        "\(snapshot.quality.status.rawValue) · \(snapshot.quality.cacheStatus.rawValue)"
                    )
                    row("Version", snapshot.quality.calculationVersion)
                    ForEach(snapshot.quality.warnings, id: \.self) { warning in
                        Label(warning, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(Color.appWarning)
                    }
                }
                Section("Observed structure") {
                    row("Call gamma", optionalNotional(snapshot.structure.callGammaExposure))
                    row("Put gamma", optionalNotional(snapshot.structure.putGammaExposure))
                    row("Gross gamma", optionalNotional(snapshot.structure.grossGammaExposure))
                    row(
                        "Call delta notional",
                        optionalNotional(snapshot.structure.callDeltaNotional)
                    )
                    row(
                        "Put delta notional",
                        optionalNotional(snapshot.structure.putDeltaNotional)
                    )
                    row(
                        "Gross concentration",
                        snapshot.structure.grossGammaConcentration.map {
                            "\(Int(($0 * 100).rounded()))%"
                        } ?? "Unavailable"
                    )
                    optionalPriceRow("Call wall", snapshot.structure.callWall)
                    optionalPriceRow("Put wall", snapshot.structure.putWall)
                    optionalPriceRow("Max OI strike", snapshot.structure.maxOpenInterestStrike)
                }
                if settings.showImpliedRange, let range = snapshot.impliedRange {
                    Section("Implied range") {
                        row("Model range", "\(Format.price(range.lower)) – \(Format.price(range.upper))")
                        row("Confidence", "\(Int((range.confidence * 100).rounded()))%")
                        row("Label", range.label)
                        row("ATM IV", String(format: "%.2f%%", range.atmIv * 100))
                        row(
                            "Straddle break-even",
                            "\(Format.price(range.straddleLower)) – \(Format.price(range.straddleUpper))"
                        )
                    }
                }
                if !snapshot.strikes.isEmpty {
                    Section("Strike profile details") {
                        ForEach(snapshot.strikes, id: \.strike) { strike in
                            DisclosureGroup("Strike \(Format.strike(strike.strike))") {
                                row("Total open interest", "\(strike.totalOpenInterest)")
                                row(
                                    "Gross gamma",
                                    strike.grossGammaExposure.map(
                                        OptionsAnalyticsPresentation.notionalText
                                    ) ?? "Unavailable"
                                )
                                if settings.showDealerProxy,
                                   let exposure = proxyExposure(at: strike.strike) {
                                    row(
                                        "Dealer proxy exposure",
                                        OptionsAnalyticsPresentation.notionalText(exposure)
                                    )
                                }
                                if let call = strike.call {
                                    legRows(side: "Call", leg: call)
                                }
                                if let put = strike.put {
                                    legRows(side: "Put", leg: put)
                                }
                            }
                        }
                    }
                }
                if settings.showDealerProxy, let proxy = snapshot.scenarios.callPutDealerProxy {
                    Section("Optional scenario — not observed dealer inventory") {
                        Text("Assumption: \(proxy.assumption)")
                        row("Gamma", OptionsAnalyticsPresentation.notionalText(proxy.gammaExposure))
                        row("Delta notional", OptionsAnalyticsPresentation.notionalText(proxy.deltaNotional))
                        row(
                            "Gamma flip proxy roots",
                            proxy.gammaRoots.map { Format.price($0) }.joined(separator: ", ")
                        )
                        optionalPriceRow("Primary gamma flip proxy", proxy.primaryGammaRoot)
                    }
                }
            }
            .navigationTitle("Options Structure")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func age(_ timestamp: String?) -> String {
        guard let timestamp,
              let date = DateParsing.dateTime(timestamp)
        else { return "Unavailable" }
        let seconds = max(0, Int(Date().timeIntervalSince(date).rounded()))
        return "\(seconds)s · \(timestamp)"
    }

    @ViewBuilder
    private func row(_ label: String, _ value: String) -> some View {
        LabeledContent(label, value: value)
    }

    @ViewBuilder
    private func optionalPriceRow(_ label: String, _ value: Double?) -> some View {
        LabeledContent(label, value: value.map(Format.strike) ?? "Unavailable")
    }

    private func optionalNotional(_ value: Double?) -> String {
        value.map(OptionsAnalyticsPresentation.notionalText) ?? "Unavailable"
    }

    private func proxyExposure(at strike: Double) -> Double? {
        snapshot.scenarios.callPutDealerProxy?.strikeGammaExposures
            .first(where: { $0.strike == strike })?.gammaExposure
    }

    @ViewBuilder
    private func legRows(side: String, leg: OptionsAnalyticsLegDTO) -> some View {
        let details = OptionsAnalyticsPresentation.legDetails(side: side, leg: leg)
        ForEach(details.indices, id: \.self) { index in
            row(details[index].label, details[index].value)
        }
    }
}
