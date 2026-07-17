import Foundation

enum APIError: Error, Equatable {
    /// Server responded with `{ "error": { "code", "message" } }`.
    case server(code: String, message: String, status: Int)
    /// Non-2xx response without a decodable error envelope.
    case httpStatus(Int)
    /// Transport-level failure (no connectivity, timeout, ...).
    case network(underlying: String)
    /// Response body could not be decoded into the expected type.
    case decoding
    /// The request could not even be constructed.
    case invalidRequest
    /// Access token expired and the refresh token was rejected; the session is dead.
    case unauthorized

    var userMessage: String {
        switch self {
        case let .server(_, message, _):
            return message
        case let .httpStatus(status):
            return "Request failed (HTTP \(status))."
        case let .network(underlying):
            return "Network error: \(underlying)"
        case .decoding:
            return "Unexpected response from server."
        case .invalidRequest:
            return "Invalid request."
        case .unauthorized:
            return "Session expired. Please log in again."
        }
    }
}
