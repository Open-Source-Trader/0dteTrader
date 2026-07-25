#if canImport(FoundationModels)
import Foundation
import FoundationModels

@available(iOS 26, *)
@MainActor
final class AIAnalysisViewModel: ObservableObject {
    @Published private(set) var analysis: MarketAnalysis?
    @Published private(set) var isAnalyzing = false
    @Published private(set) var errorMessage: String?

    var isModelAvailable: Bool {
        SystemLanguageModel.default.isAvailable
    }

    func analyze(snapshot: AIAnalysisSnapshot) async {
        guard !isAnalyzing else { return }
        isAnalyzing = true
        errorMessage = nil
        analysis = nil
        defer { isAnalyzing = false }

        guard !snapshot.candles.isEmpty || snapshot.quote != nil else {
            errorMessage = "No market data available yet. Wait for data to load, then try again."
            Haptics.error()
            return
        }

        guard SystemLanguageModel.default.isAvailable else {
            errorMessage = "Apple Intelligence is not available on this device. Ensure Siri & Apple Intelligence is enabled in Settings."
            Haptics.error()
            return
        }

        let limits = [AIAnalysisPromptBuilder.defaultCandleLimit,
                      AIAnalysisPromptBuilder.retryCandleLimit]
        do {
            for (index, limit) in limits.enumerated() {
                do {
                    analysis = try await respond(
                        to: AIAnalysisPromptBuilder.buildPrompt(from: snapshot, candleLimit: limit)
                    )
                    Haptics.success()
                    return
                } catch LanguageModelSession.GenerationError.exceededContextWindowSize
                    where index < limits.count - 1 {
                    // Retry once with a smaller prompt in a fresh session (TN3193).
                }
            }
        } catch is CancellationError {
            // Sheet dismissed mid-generation; silent.
        } catch LanguageModelSession.GenerationError.exceededContextWindowSize {
            errorMessage = "Analysis failed: too much market data for the on-device model. Disable some chart indicators and try again."
            Haptics.error()
        } catch {
            errorMessage = "Analysis failed: \(error.localizedDescription)"
            Haptics.error()
        }
    }

    private func respond(to prompt: String) async throws -> MarketAnalysis {
        #if DEBUG
        print("[AIAnalysis] prompt: \(prompt.count) chars (~\(prompt.count / 4)–\(prompt.count / 3) tokens)")
        #endif
        let session = LanguageModelSession(
            instructions: AIAnalysisPromptBuilder.systemInstructions
        )
        return try await session.respond(to: prompt, generating: MarketAnalysis.self).content
    }

    func reset() {
        analysis = nil
        errorMessage = nil
    }
}
#endif
