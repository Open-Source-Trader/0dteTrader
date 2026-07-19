#if canImport(FoundationModels)
import SwiftUI

@available(iOS 26, *)
struct AIAnalysisSheet: View {
    @ObservedObject var chartViewModel: ChartViewModel
    @ObservedObject var chainViewModel: OptionsChainViewModel
    @StateObject private var viewModel = AIAnalysisViewModel()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            content
                .background(Color.appBackground)
                .navigationTitle("AI Analysis")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done") { dismiss() }
                    }
                }
                .toolbarBackground(Color.appBackground, for: .navigationBar)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Color.appBackground)
        .task { await runAnalysis() }
    }

    // MARK: - Content states

    @ViewBuilder
    private var content: some View {
        if viewModel.isAnalyzing {
            loadingState
        } else if let error = viewModel.errorMessage {
            ErrorStateView(
                message: error,
                systemImage: "brain.head.profile",
                retryTitle: "Try Again"
            ) {
                Task { await runAnalysis() }
            }
            .frame(maxHeight: .infinity)
        } else if let analysis = viewModel.analysis {
            resultView(analysis)
        } else {
            Color.clear
        }
    }

    private var loadingState: some View {
        VStack(spacing: AppSpacing.lg) {
            ProgressView()
                .controlSize(.large)
                .tint(Color.appAccent)
            Text("Analyzing \(chartViewModel.symbol)…")
                .font(.panelLabel)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Result

    private func resultView(_ analysis: MarketAnalysis) -> some View {
        ScrollView(.vertical) {
            VStack(spacing: AppSpacing.xl) {
                sentimentCard(analysis)
                observationsCard(analysis.observations)
                summaryCard(analysis.summary)
                reanalyzeButton
                disclaimer
            }
            .padding(AppSpacing.lg)
        }
    }

    private func sentimentCard(_ analysis: MarketAnalysis) -> some View {
        VStack(spacing: AppSpacing.md) {
            Image(systemName: sentimentIcon(analysis.sentiment))
                .font(.system(size: 40))
                .foregroundStyle(sentimentColor(analysis.sentiment))
                .shadow(color: sentimentColor(analysis.sentiment).opacity(0.5), radius: 12)

            Text(analysis.sentiment.rawValue.uppercased())
                .font(.hudTitle)
                .foregroundStyle(sentimentColor(analysis.sentiment))

            confidenceBar(value: analysis.confidence, color: sentimentColor(analysis.sentiment))
        }
        .padding(AppSpacing.xl)
        .frame(maxWidth: .infinity)
        .hudCard(accent: sentimentColor(analysis.sentiment), glow: true, ticks: true)
    }

    private func confidenceBar(value: Int, color: Color) -> some View {
        VStack(spacing: AppSpacing.xs) {
            Text("CONFIDENCE")
                .font(.chipLabel)
                .foregroundStyle(.secondary)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    HudPanelShape(chamfer: 4)
                        .fill(Color.appSurface)
                    HudPanelShape(chamfer: 4)
                        .fill(color.opacity(0.6))
                        .frame(width: geo.size.width * CGFloat(min(max(value, 0), 100)) / 100)
                }
            }
            .frame(height: 8)
            Text("\(value)%")
                .font(.priceSmall)
                .foregroundStyle(color)
        }
    }

    private func observationsCard(_ observations: [String]) -> some View {
        VStack(alignment: .leading, spacing: AppSpacing.md) {
            Text("KEY OBSERVATIONS")
                .font(.chipLabel)
                .foregroundStyle(Color.appAccent)

            ForEach(Array(observations.enumerated()), id: \.offset) { _, observation in
                HStack(alignment: .top, spacing: AppSpacing.sm) {
                    Circle()
                        .fill(Color.appAccent)
                        .frame(width: 5, height: 5)
                        .padding(.top, 6)
                    Text(observation)
                        .font(.priceMedium)
                        .foregroundStyle(.primary)
                }
            }
        }
        .padding(AppSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .hudCard(accent: .hudStrokeDim, glow: false, ticks: false)
    }

    private func summaryCard(_ summary: String) -> some View {
        VStack(alignment: .leading, spacing: AppSpacing.sm) {
            Text("ANALYSIS")
                .font(.chipLabel)
                .foregroundStyle(Color.appAccent)
            Text(summary)
                .font(.priceMedium)
                .foregroundStyle(.primary)
        }
        .padding(AppSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .hudCard(accent: .hudStrokeDim, glow: false, ticks: false)
    }

    private var reanalyzeButton: some View {
        Button {
            Task { await runAnalysis() }
        } label: {
            HStack(spacing: AppSpacing.sm) {
                Image(systemName: "arrow.clockwise")
                Text("Re-analyze")
            }
            .font(.chipLabel)
            .foregroundStyle(.white)
            .padding(.horizontal, AppSpacing.lg)
            .frame(minHeight: 44)
            .background(Color.appAccentFill)
            .clipShape(Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(AppPressStyle())
    }

    private var disclaimer: some View {
        Text("Generated by on-device AI. Not financial advice.")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
    }

    // MARK: - Helpers

    private func buildSnapshot() -> AIAnalysisSnapshot {
        var indicators = AIAnalysisSnapshot.Indicators()
        indicators.overlays = chartViewModel.priceOverlays.map {
            .init(name: $0.name, values: $0.values)
        }
        indicators.rsi = chartViewModel.rsiSeries?.values
        if let macd = chartViewModel.macdSeries {
            indicators.macdLine = macd.macd.values
            indicators.macdSignal = macd.signal.values
            indicators.macdHistogram = macd.histogram.values
        }
        if let stoch = chartViewModel.stochSeries {
            indicators.stochK = stoch.k.values
            indicators.stochD = stoch.d.values
        }
        indicators.atr = chartViewModel.atrSeries?.values

        return AIAnalysisSnapshot(
            symbol: chartViewModel.symbol,
            interval: chartViewModel.interval.rawValue,
            candles: chartViewModel.candles,
            quote: chartViewModel.quote,
            dayChange: chartViewModel.dayChange.map {
                .init(change: $0.change, percent: $0.percent)
            },
            indicators: indicators,
            gexLevels: chartViewModel.gexLevels,
            twcBias: chartViewModel.twcRenderModel?.banner?.text,
            chain: chainViewModel.chain.map {
                .init(
                    underlying: $0.underlying,
                    underlyingPrice: $0.underlyingPrice,
                    nearestExpiration: chainViewModel.selectedExpiration,
                    callCount: $0.contracts.filter { $0.optionType == .call }.count,
                    putCount: $0.contracts.filter { $0.optionType == .put }.count
                )
            }
        )
    }

    private func runAnalysis() async {
        await viewModel.analyze(snapshot: buildSnapshot())
    }

    private func sentimentColor(_ sentiment: MarketSentiment) -> Color {
        switch sentiment {
        case .bullish: return .buyGreen
        case .neutral: return .appAccent
        case .bearish: return .sellRed
        }
    }

    private func sentimentIcon(_ sentiment: MarketSentiment) -> String {
        switch sentiment {
        case .bullish: return "arrow.up.circle.fill"
        case .neutral: return "equal.circle.fill"
        case .bearish: return "arrow.down.circle.fill"
        }
    }
}
#endif
