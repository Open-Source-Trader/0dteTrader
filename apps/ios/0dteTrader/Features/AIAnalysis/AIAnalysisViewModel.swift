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

        let prompt = AIAnalysisPromptBuilder.buildPrompt(from: snapshot)

        do {
            let session = LanguageModelSession(
                instructions: AIAnalysisPromptBuilder.systemInstructions
            )
            let response = try await session.respond(to: prompt, generating: MarketAnalysis.self)
            analysis = response.content
            Haptics.success()
        } catch is CancellationError {
            // Sheet dismissed mid-generation; silent.
        } catch {
            errorMessage = "Analysis failed: \(error.localizedDescription)"
            Haptics.error()
        }
    }

    func reset() {
        analysis = nil
        errorMessage = nil
    }
}
#endif
