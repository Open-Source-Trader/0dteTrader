import XCTest
@testable import ShimCore

final class GroundingValidatorTests: XCTestCase {
    func testKeepsAReferenceMatchingASuppliedCandidate() {
        let reference = GroundingValidator.LevelReference(levelId: "lvl-1", price: 400)
        let result = GroundingValidator.groundOrReject(reference, candidateIds: ["lvl-1", "lvl-2"])
        XCTAssertEqual(result, reference)
    }

    func testRejectsAGeneratedLevelWithNoMatchingCandidate() {
        let reference = GroundingValidator.LevelReference(levelId: "ghost-level", price: 401)
        let result = GroundingValidator.groundOrReject(reference, candidateIds: ["lvl-1", "lvl-2"])
        XCTAssertNil(result)
    }

    func testNilReferencePassesThroughAsNil() {
        let result = GroundingValidator.groundOrReject(nil, candidateIds: ["lvl-1"])
        XCTAssertNil(result)
    }

    func testEmptyCandidateSetRejectsEveryReference() {
        let reference = GroundingValidator.LevelReference(levelId: "lvl-1", price: 400)
        let result = GroundingValidator.groundOrReject(reference, candidateIds: [])
        XCTAssertNil(result)
    }
}
