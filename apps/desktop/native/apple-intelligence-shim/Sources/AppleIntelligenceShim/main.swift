import Foundation
import ShimCore

// Stdout is protocol-only (docs/apple-intelligence/protocol.md) — never
// `print()` diagnostics here. Use FileHandle.standardError for anything
// human-readable.
func logDiagnostic(_ message: String) {
    let line = "[apple-intelligence-shim] \(message)\n"
    if let data = line.data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
}

let outputLock = NSLock()
func writeEvent(_ event: NativeEvent) {
    guard let line = NDJSONCodec.encodeEvent(event) else { return }
    outputLock.lock()
    defer { outputLock.unlock() }
    print(line)
    fflush(stdout)
}

let handler = RequestHandler()

logDiagnostic("starting")

// Read one NDJSON request per line from stdin, dispatching each to the actor
// inside a shared TaskGroup so a long-running analysis doesn't block reading
// the next line (e.g. a cancel request for that same analysis), while stdin
// EOF still waits for in-flight requests to finish emitting their terminal
// event before the process exits.
await withTaskGroup(of: Void.self) { group in
    while let line = readLine(strippingNewline: true) {
        guard let request = NDJSONCodec.decodeRequest(line: line) else {
            logDiagnostic("dropped malformed or unrecognized request line")
            continue
        }
        group.addTask {
            await handler.handle(request) { event in
                writeEvent(event)
            }
        }
    }
    logDiagnostic("stdin closed, draining in-flight requests")
}

logDiagnostic("exiting")
