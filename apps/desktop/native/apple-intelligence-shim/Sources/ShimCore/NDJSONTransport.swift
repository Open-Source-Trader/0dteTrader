import Foundation

/// Encodes/decodes single NDJSON lines. Stdout is protocol-only (see
/// docs/apple-intelligence/protocol.md); this type has no knowledge of the
/// stdin/stdout file handles themselves — that belongs to the executable's
/// I/O loop, not this pure encode/decode logic.
public enum NDJSONCodec {
    private static let decoder: JSONDecoder = JSONDecoder()
    private static let encoder: JSONEncoder = JSONEncoder()

    /// Decodes one line into a `NativeRequest`. Returns nil on malformed
    /// JSON or a schema mismatch — callers must treat nil as a protocol
    /// violation, never crash the process.
    public static func decodeRequest(line: String) -> NativeRequest? {
        guard let data = line.data(using: .utf8) else { return nil }
        return try? decoder.decode(NativeRequest.self, from: data)
    }

    /// Encodes one `NativeEvent` as a single line (no trailing newline —
    /// the caller's writer owns line termination).
    public static func encodeEvent(_ event: NativeEvent) -> String? {
        guard let data = try? encoder.encode(event) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
