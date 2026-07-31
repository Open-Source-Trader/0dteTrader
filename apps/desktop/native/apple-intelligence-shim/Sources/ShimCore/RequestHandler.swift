import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Phase 1 scope only: hello handshake, availability, prewarm, a fixed
/// bounded test analyze payload, cancellation, and shutdown. Structured
/// snapshot/result schemas are Phase 2 (docs/apple-intelligence/
/// implementation-plan.md). Single-flight: one active analysis task at a
/// time, per the ADR (docs/apple-intelligence/adr-swift-sidecar.md).
public actor RequestHandler {
    public static let shimVersion = "0.1.0"

    private var activeAnalysisTask: Task<Void, Never>?
    private var activeRequestId: String?

    public init() {}

    public func handle(_ request: NativeRequest, emit: @escaping @Sendable (NativeEvent) -> Void) async {
        switch request.method {
        case .runtimeHello:
            emit(helloEvent(requestId: request.requestId))
        case .runtimeAvailability:
            emit(availabilityEvent(requestId: request.requestId))
        case .runtimePrewarm:
            emit(NativeEvent(requestId: request.requestId, event: .completed))
        case .analysisRun:
            await startAnalysis(request, emit: emit)
        case .analysisCancel:
            await cancelActive(requestId: request.requestId, emit: emit)
        case .runtimeShutdown:
            await cancelActive(requestId: activeRequestId ?? request.requestId, emit: emit)
            emit(NativeEvent(requestId: request.requestId, event: .completed))
        }
    }

    private func helloEvent(requestId: String) -> NativeEvent {
        let payload = RuntimeReadyPayload(
            shimVersion: Self.shimVersion,
            supportedProtocolVersions: [protocolVersion],
            snapshotSchemaVersions: [1],
            resultSchemaVersions: [1],
            capabilities: ["availability", "prewarm", "structured-generation", "cancellation"]
        )
        return NativeEvent(requestId: requestId, event: .ready, payload: encodePayload(payload))
    }

    private func availabilityEvent(requestId: String) -> NativeEvent {
        switch AvailabilityService.current() {
        case .ready:
            return NativeEvent(requestId: requestId, event: .completed, payload: .object(["state": .string("ready")]))
        case .unavailable(let reason):
            return NativeEvent(
                requestId: requestId,
                event: .completed,
                payload: .object(["state": .string("unavailable"), "reason": .string(reason)])
            )
        }
    }

    /// Fixed bounded test payload only (Phase 1) — the request's own
    /// `payload` field is not yet parsed into a real analysis snapshot.
    private func startAnalysis(_ request: NativeRequest, emit: @escaping @Sendable (NativeEvent) -> Void) async {
        // Single-flight: a new analysis request while one is active cancels
        // the prior one rather than running concurrently.
        if let previousTask = activeAnalysisTask {
            previousTask.cancel()
            _ = await previousTask.value
        }

        let requestId = request.requestId
        activeRequestId = requestId

        let task = Task { [weak self] in
            guard let self else { return }
            emit(NativeEvent(requestId: requestId, event: .accepted))

            guard case .ready = AvailabilityService.current() else {
                emit(
                    NativeEvent(
                        requestId: requestId,
                        event: .failed,
                        error: NativeErrorPayload(code: .runtimeUnavailable, message: "model unavailable")
                    )
                )
                await self.clearActive(requestId: requestId)
                return
            }

            if Task.isCancelled {
                emit(NativeEvent(requestId: requestId, event: .cancelled))
                await self.clearActive(requestId: requestId)
                return
            }

            // Phase 1 bounded test generation: a trivial fixed prompt proves
            // the handshake/session/cancellation path end to end. Real
            // snapshot-driven prompts and structured @Generable results are
            // Phase 2.
            #if canImport(FoundationModels)
            if #available(macOS 26, *) {
                do {
                    let session = LanguageModelSession(instructions: "Reply with exactly one word.")
                    let response = try await session.respond(to: "Say 'ready'.")
                    if Task.isCancelled {
                        emit(NativeEvent(requestId: requestId, event: .cancelled))
                    } else {
                        emit(
                            NativeEvent(
                                requestId: requestId,
                                event: .completed,
                                payload: .object(["text": .string(response.content)])
                            )
                        )
                    }
                } catch is CancellationError {
                    emit(NativeEvent(requestId: requestId, event: .cancelled))
                } catch {
                    emit(
                        NativeEvent(
                            requestId: requestId,
                            event: .failed,
                            error: NativeErrorPayload(code: .modelRuntimeFailure, message: "generation failed")
                        )
                    )
                }
            } else {
                emit(
                    NativeEvent(
                        requestId: requestId,
                        event: .failed,
                        error: NativeErrorPayload(code: .runtimeIncompatible, message: "os-version-unsupported")
                    )
                )
            }
            #else
            emit(
                NativeEvent(
                    requestId: requestId,
                    event: .failed,
                    error: NativeErrorPayload(code: .runtimeUnavailable, message: "foundation-models-unavailable")
                )
            )
            #endif

            await self.clearActive(requestId: requestId)
        }
        activeAnalysisTask = task
    }

    private func cancelActive(requestId: String, emit: @escaping @Sendable (NativeEvent) -> Void) async {
        guard let task = activeAnalysisTask, activeRequestId == requestId else { return }
        task.cancel()
        _ = await task.value
    }

    private func clearActive(requestId: String) {
        guard activeRequestId == requestId else { return }
        activeAnalysisTask = nil
        activeRequestId = nil
    }
}

private func encodePayload<T: Encodable>(_ value: T) -> JSONValue? {
    guard let data = try? JSONEncoder().encode(value) else { return nil }
    guard let jsonValue = try? JSONDecoder().decode(JSONValue.self, from: data) else { return nil }
    return jsonValue
}
