import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Hello handshake, availability, prewarm, snapshot-driven structured
/// analysis, cancellation, and shutdown. Single-flight: one active analysis
/// task at a time, per the ADR (docs/apple-intelligence/adr-swift-sidecar.md).
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

    private func startAnalysis(_ request: NativeRequest, emit: @escaping @Sendable (NativeEvent) -> Void) async {
        // Single-flight: a new analysis request while one is active cancels
        // the prior one rather than running concurrently.
        if let previousTask = activeAnalysisTask {
            previousTask.cancel()
            _ = await previousTask.value
        }

        let requestId = request.requestId
        activeRequestId = requestId
        let payload = request.payload

        let task = Task { [weak self] in
            guard let self else { return }
            emit(NativeEvent(requestId: requestId, event: .accepted))

            guard let snapshot = AnalysisRunner.decodeSnapshot(from: payload) else {
                emit(
                    NativeEvent(
                        requestId: requestId,
                        event: .failed,
                        error: NativeErrorPayload(code: .payloadInvalid, message: "snapshot did not match the expected schema")
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

            do {
                let resultPayload = try await AnalysisRunner.run(snapshot: snapshot) { Task.isCancelled }
                if Task.isCancelled {
                    emit(NativeEvent(requestId: requestId, event: .cancelled))
                } else {
                    emit(NativeEvent(requestId: requestId, event: .completed, payload: resultPayload))
                }
            } catch is CancellationError {
                emit(NativeEvent(requestId: requestId, event: .cancelled))
            } catch let error as AnalysisRunError {
                emit(NativeEvent(requestId: requestId, event: .failed, error: nativeError(forAnalysisRunError: error)))
            } catch {
                emit(
                    NativeEvent(
                        requestId: requestId,
                        event: .failed,
                        error: NativeErrorPayload(code: .modelRuntimeFailure, message: "generation failed")
                    )
                )
            }

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

private func nativeError(forAnalysisRunError error: AnalysisRunError) -> NativeErrorPayload {
    switch error {
    case .payloadInvalid:
        return NativeErrorPayload(code: .payloadInvalid, message: "snapshot payload invalid")
    case .modelUnavailable:
        return NativeErrorPayload(code: .runtimeUnavailable, message: "model unavailable")
    case .structuredOutputInvalid:
        return NativeErrorPayload(code: .structuredOutputInvalid, message: "structured output failed validation")
    case .guardrailRejection:
        return NativeErrorPayload(code: .modelGuardrailRejection, message: "model declined to generate")
    case .runtimeFailure:
        return NativeErrorPayload(code: .modelRuntimeFailure, message: "generation failed")
    }
}
