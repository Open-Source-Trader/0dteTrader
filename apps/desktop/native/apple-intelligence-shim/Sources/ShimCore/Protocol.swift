import Foundation

// Canonical spec: docs/apple-intelligence/protocol.md — this file is the
// Swift-side runtime implementation of that spec, mirroring
// apps/desktop/electron/appleIntelligence/protocol.cjs message-for-message.
// The two must be able to decode the same golden fixtures.

public let protocolVersion = 1

public enum NativeMethod: String, Codable, Sendable {
    case runtimeHello = "runtime.hello"
    case runtimeAvailability = "runtime.availability"
    case runtimePrewarm = "runtime.prewarm"
    case analysisRun = "analysis.run"
    case analysisCancel = "analysis.cancel"
    case runtimeShutdown = "runtime.shutdown"
}

public enum NativeEventKind: String, Codable, Sendable {
    case ready
    case accepted
    case progress
    case partial
    case completed
    case cancelled
    case failed
}

public enum NativeErrorCode: String, Codable, Sendable {
    case runtimeUnavailable = "runtime_unavailable"
    case runtimeIncompatible = "runtime_incompatible"
    case nativeProcessExited = "native_process_exited"
    case handshakeTimeout = "handshake_timeout"
    case requestTimeout = "request_timeout"
    case requestCancelled = "request_cancelled"
    case payloadInvalid = "payload_invalid"
    case payloadTooLarge = "payload_too_large"
    case protocolMalformedJson = "protocol_malformed_json"
    case protocolUnknownMethod = "protocol_unknown_method"
    case protocolUnknownEvent = "protocol_unknown_event"
    case protocolSequenceViolation = "protocol_sequence_violation"
    case protocolDuplicateTerminal = "protocol_duplicate_terminal"
    case contextBudgetExceeded = "context_budget_exceeded"
    case structuredOutputInvalid = "structured_output_invalid"
    case modelGuardrailRejection = "model_guardrail_rejection"
    case modelRuntimeFailure = "model_runtime_failure"
}

public struct NativeErrorPayload: Codable, Sendable {
    public let code: NativeErrorCode
    public let message: String

    public init(code: NativeErrorCode, message: String) {
        self.code = code
        self.message = message
    }
}

public struct NativeRequest: Codable, Sendable {
    public let protocolVersion: Int
    public let requestId: String
    public let method: NativeMethod
    public let deadlineAt: String?
    public let payload: JSONValue?
}

public struct NativeEvent: Codable, Sendable {
    public let protocolVersion: Int
    public let requestId: String
    public let event: NativeEventKind
    public let sequence: Int?
    public let payload: JSONValue?
    public let error: NativeErrorPayload?

    public init(
        requestId: String,
        event: NativeEventKind,
        sequence: Int? = nil,
        payload: JSONValue? = nil,
        error: NativeErrorPayload? = nil
    ) {
        self.protocolVersion = ShimCore.protocolVersion
        self.requestId = requestId
        self.event = event
        self.sequence = sequence
        self.payload = payload
        self.error = error
    }
}

public struct RuntimeReadyPayload: Codable, Sendable {
    public let shimVersion: String
    public let supportedProtocolVersions: [Int]
    public let snapshotSchemaVersions: [Int]
    public let resultSchemaVersions: [Int]
    public let capabilities: [String]

    public init(
        shimVersion: String,
        supportedProtocolVersions: [Int],
        snapshotSchemaVersions: [Int],
        resultSchemaVersions: [Int],
        capabilities: [String]
    ) {
        self.shimVersion = shimVersion
        self.supportedProtocolVersions = supportedProtocolVersions
        self.snapshotSchemaVersions = snapshotSchemaVersions
        self.resultSchemaVersions = resultSchemaVersions
        self.capabilities = capabilities
    }
}
