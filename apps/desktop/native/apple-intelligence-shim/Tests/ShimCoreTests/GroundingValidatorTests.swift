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

    func testKeepsAContractPriceWithinAGenerousMultipleOfTheReference() {
        let result = GroundingValidator.groundOrRejectContractPrice(1.85, contractReference: 1.80)
        XCTAssertEqual(result, 1.85)
    }

    func testRejectsAContractPriceWithNoSuppliedReference() {
        let result = GroundingValidator.groundOrRejectContractPrice(1.85, contractReference: nil)
        XCTAssertNil(result)
    }

    func testRejectsAContractPriceFarBeyondTheReference() {
        let result = GroundingValidator.groundOrRejectContractPrice(1000, contractReference: 1.80)
        XCTAssertNil(result)
    }

    func testRejectsANonPositiveContractPrice() {
        let result = GroundingValidator.groundOrRejectContractPrice(0, contractReference: 1.80)
        XCTAssertNil(result)
    }

    func testNilContractPricePassesThroughAsNil() {
        let result = GroundingValidator.groundOrRejectContractPrice(nil, contractReference: 1.80)
        XCTAssertNil(result)
    }
}
