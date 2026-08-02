import XCTest
@testable import ShimCore

final class GroundingValidatorTests: XCTestCase {
    func testResolvesTheCandidatesOwnPriceForAMatchingId() {
        let result = GroundingValidator.groundOrReject(
            levelId: "lvl-1",
            candidatePrices: ["lvl-1": 400, "lvl-2": 410]
        )
        XCTAssertEqual(result, GroundingValidator.LevelReference(levelId: "lvl-1", price: 400))
    }

    func testRejectsAGeneratedLevelWithNoMatchingCandidate() {
        let result = GroundingValidator.groundOrReject(
            levelId: "ghost-level",
            candidatePrices: ["lvl-1": 400, "lvl-2": 410]
        )
        XCTAssertNil(result)
    }

    func testNilLevelIdPassesThroughAsNil() {
        let result = GroundingValidator.groundOrReject(levelId: nil, candidatePrices: ["lvl-1": 400])
        XCTAssertNil(result)
    }

    func testEmptyCandidateSetRejectsEveryReference() {
        let result = GroundingValidator.groundOrReject(levelId: "lvl-1", candidatePrices: [:])
        XCTAssertNil(result)
    }

    /// The security-relevant case: there is no generated price parameter to
    /// pass at all — the API only accepts an id, so a caller cannot even
    /// attempt to supply a fabricated price alongside a valid id. Resolution
    /// always reflects the snapshot's own value for that id.
    func testResolvedPriceAlwaysComesFromTheCandidateNeverFromAnExternalValue() {
        let candidatePrices = ["lvl-1": 578.5]
        let result = GroundingValidator.groundOrReject(levelId: "lvl-1", candidatePrices: candidatePrices)
        XCTAssertEqual(result?.price, 578.5)
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
