import XCTest
@testable import ShimCore

final class ProtocolTests: XCTestCase {
    func testDecodesValidHelloRequest() throws {
        let line = """
        {"protocolVersion":1,"requestId":"r1","method":"runtime.hello","payload":{}}
        """
        let request = NDJSONCodec.decodeRequest(line: line)
        XCTAssertNotNil(request)
        XCTAssertEqual(request?.method, .runtimeHello)
        XCTAssertEqual(request?.requestId, "r1")
    }

    func testRejectsMalformedJson() {
        let line = "{\"protocolVersion\":1,\"requestId\":\"r1\","
        XCTAssertNil(NDJSONCodec.decodeRequest(line: line))
    }

    func testRejectsUnknownMethod() {
        let line = """
        {"protocolVersion":1,"requestId":"r1","method":"analysis.frobnicate","payload":{}}
        """
        XCTAssertNil(NDJSONCodec.decodeRequest(line: line))
    }

    func testRejectsNonFiniteNumberInPayload() {
        let line = """
        {"protocolVersion":1,"requestId":"r1","method":"analysis.run","payload":{"x":NaN}}
        """
        XCTAssertNil(NDJSONCodec.decodeRequest(line: line))
    }

    func testEncodesReadyEventRoundTrip() throws {
        let payload = RuntimeReadyPayload(
            shimVersion: "0.1.0",
            supportedProtocolVersions: [1],
            snapshotSchemaVersions: [1],
            resultSchemaVersions: [1],
            capabilities: ["availability"]
        )
        let data = try JSONEncoder().encode(payload)
        let jsonValue = try JSONDecoder().decode(JSONValue.self, from: data)
        let event = NativeEvent(requestId: "runtime", event: .ready, payload: jsonValue)
        let line = NDJSONCodec.encodeEvent(event)
        XCTAssertNotNil(line)
        XCTAssertTrue(line!.contains("\"event\":\"ready\""))
    }

    func testEncodedEventContainsNoTrailingNewline() {
        let event = NativeEvent(requestId: "r1", event: .accepted)
        let line = NDJSONCodec.encodeEvent(event)
        XCTAssertNotNil(line)
        XCTAssertFalse(line!.contains("\n"))
    }
}
